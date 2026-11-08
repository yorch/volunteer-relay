import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createAuth } from "../../../apps/web/lib/auth/auth.ts";
import { provisionDemo } from "../../../apps/web/lib/auth/demo.ts";
import { seedProductDemo } from "../../../apps/web/lib/auth/product-demo.ts";
import { createProductExtensions } from "../../../apps/web/lib/product/extensions.ts";
import { createWorkspaceActivityReader } from "../../../apps/web/lib/product/workspace-projections.ts";
import { verifyProposalEvidence } from "../../../packages/ai/src/index.ts";
import { createFilesystemBlobStore } from "../../../packages/blob/src/index.ts";
import {
  createAttachmentMetadataStore,
  createDomainStore,
  createMembershipReader,
  createProcessingRepository,
  createSourceStore,
  type Database,
  sql,
} from "../../../packages/db/src/index.ts";
import { createRetentionRepository } from "../../../packages/db/src/repositories/retention.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import {
  createAttachmentReader,
  createLedgerService,
  createNeedService,
  createSourceRepository,
} from "../../../packages/domain/core/src/index.ts";
import { readPrivateBlob } from "../../../packages/intake/src/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

let db: Database;
let close: () => Promise<void>;
let root: string;
const sharp: typeof import("../../../apps/web/node_modules/sharp/lib/index.js") =
  createRequire(new URL("../../../apps/web/package.json", import.meta.url))(
    "sharp",
  );
const env = { NODE_ENV: "test", DEMO_MODE: "true" };
const args = ["--demo"];
let auth: ReturnType<typeof createAuth>;
let authorization: ReturnType<typeof createAuthorizationService>;
const getContext = async (user: string, org: string) => {
  const result = await authorization.resolve(user, org, "demo-test");
  if (!result.ok) throw new Error(`Missing demo membership ${user}`);
  return result.value;
};
const store = () => createFilesystemBlobStore({ root });
const seed = () => seedProductDemo({ db, store: store() }, args, env);
const counts = async () =>
  (
    await db.execute(
      sql`select (select count(*)::int from source_revision) sources,(select count(*)::int from extraction_run) proposals,(select count(*)::int from activity) activities,(select count(*)::int from contribution) contributions,(select count(*)::int from need) needs,(select count(*)::int from domain_audit_event) audit,(select count(*)::int from outbox_event) outbox,(select count(*)::int from delivery_job) delivery`,
    )
  ).rows[0];
beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  auth = createAuth({
    db,
    secret: "synthetic-integration-secret".padEnd(40, "x"),
    baseURL: "http://localhost:3000",
  });
  authorization = createAuthorizationService({
    memberships: createMembershipReader(db),
  });
});
beforeEach(async () => {
  await resetAuthTables(db);
  root = await mkdtemp(join(tmpdir(), "relay-demo-seed-"));
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected external request");
  });
  await provisionDemo({ db, auth }, args, env);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await close?.();
});

it("seeds useful tenant-scoped review, need and report states without external delivery", async () => {
  expect(await seed()).toEqual({ created: true, profileVersion: 1 });
  const owner = await getContext("demo-owner", "tidepath");
  const volunteer = await getContext("demo-volunteer", "tidepath");
  const harborReader = await getContext("demo-multi", "harbor");
  const store = createDomainStore(db);
  const ledger = createLedgerService({ authorization, store });
  const needs = createNeedService({ authorization, store });
  expect(await ledger.summarize(owner)).toMatchObject({
    ok: true,
    value: {
      approvedMinutes: 180,
      approvedContributions: 3,
      activitiesWithApprovedContributions: 2,
      pendingUnknownDuration: 1,
    },
  });
  expect(await ledger.summarize(harborReader)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 0, approvedContributions: 0 },
  });
  const listed = await needs.list(owner, { limit: 100 });
  if (!listed.ok) throw new Error("Need list unavailable");
  expect(listed.value.map((need) => need.status)).toEqual(
    expect.arrayContaining(["new", "assigned", "acknowledged", "resolved"]),
  );
  expect(
    listed.value
      .filter((need) => ["assigned", "acknowledged"].includes(need.status))
      .every((need) => need.acknowledgeBy === null),
  ).toBe(true);
  expect(listed.value).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ urgency: "urgent", provisional: true }),
    ]),
  );
  const processing = createProcessingRepository(db);
  const queue = await processing.listQueue(owner);
  if (!queue.ok) throw new Error("Review queue unavailable");
  expect(queue.value).toHaveLength(7);
  for (const entry of queue.value)
    expect(verifyProposalEvidence(entry.proposal, entry.source)).toEqual([]);
  expect(queue.value.map((entry) => entry.source.sourceId).sort()).toEqual(
    [
      "correction",
      "duplicate",
      "photo",
      "shared-review",
      "spanish",
      "unknown",
      "urgent",
    ]
      .map((name) => `demo-product:v1:${name}`)
      .sort(),
  );
  expect(
    queue.value.some((entry) =>
      entry.proposal.unresolved.some(
        (item) => item.field === "duplicateCandidate",
      ),
    ),
  ).toBe(true);
  expect(
    queue.value.some((entry) =>
      entry.proposal.items.some((item) => item.kind === "correction"),
    ),
  ).toBe(true);
  expect(
    queue.value.some((entry) => entry.source.text.includes("alimentos")),
  ).toBe(true);
  expect(
    queue.value.some((entry) =>
      entry.proposal.items.some(
        (item) => item.kind === "contribution" && item.durationMinutes === null,
      ),
    ),
  ).toBe(true);
  const photo = queue.value.find(
    (entry) => entry.source.attachments.length > 0,
  );
  if (!photo?.source.attachments[0]) throw new Error("Missing review photo");
  const attachment = photo.source.attachments[0];
  const reader = createAttachmentReader({
    authorization,
    metadata: createAttachmentMetadataStore(db),
    blobs: { read: (key) => readPrivateBlob(root, key) },
  });
  const extension = createProductExtensions({
    db,
    authorization,
    sources: createSourceRepository({
      authorization,
      store: createSourceStore(db),
    }),
    processing,
    attachments: reader,
    store: createFilesystemBlobStore({ root }),
    maxBytes: 10485760,
  });
  const report = await extension(
    owner,
    "reports",
    new Request("http://localhost/api/product/reports"),
  );
  expect(report).toMatchObject({
    ok: true,
    value: {
      ledger: {
        approvedMinutes: 180,
        approvedContributions: 3,
        activitiesWithApprovedContributions: 2,
        pendingUnknownDuration: 1,
      },
    },
  });
  const bytes = await reader.read(owner, photo.source.sourceId, attachment.id);
  expect(bytes).toMatchObject({ ok: true, value: { mimeType: "image/png" } });
  if (!bytes.ok) throw new Error("Photo unavailable");
  expect(Buffer.from(bytes.value.bytes).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  const image = await sharp(bytes.value.bytes).metadata();
  expect(image.width).toBeGreaterThanOrEqual(100);
  expect(image.height).toBeGreaterThanOrEqual(50);
  expect(
    (await reader.read(harborReader, photo.source.sourceId, attachment.id)).ok,
  ).toBe(false);
  expect(
    (await processing.getSource(harborReader, photo.source.sourceId)).ok,
  ).toBe(false);
  expect((await processing.listQueue(volunteer)).ok).toBe(false);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(
    (
      await db.execute(
        sql`select count(*)::int as count from outbox_event where dispatched_at is null`,
      )
    ).rows[0]?.count,
  ).toBe(0);
  expect(
    (
      await db.execute(
        sql`select count(*)::int as count from outbox_event e where e.type='need.changed' and not exists(select 1 from notification_event n where n.organization_id=e.organization_id and n.event_id=e.id)`,
      )
    ).rows[0]?.count,
  ).toBe(0);
  expect((await counts())?.delivery).toBe(1);
  expect(
    (
      await db.execute(
        sql`select attempts,accepted_at,provider_id from delivery_job`,
      )
    ).rows,
  ).toEqual([{ attempts: 3, accepted_at: null, provider_id: null }]);
});

it("reruns without duplication and preserves staff edits", async () => {
  expect((await seed()).created).toBe(true);
  const first = await counts();
  expect(await seed()).toEqual({ created: false, profileVersion: 1 });
  expect(await counts()).toEqual(first);
  const owner = await getContext("demo-owner", "tidepath");
  const ledger = createLedgerService({
    authorization,
    store: createDomainStore(db),
  });
  const rows = await db.execute(
    sql`select id,revision from contribution where organization_id='tidepath' and status='approved' order by id limit 1`,
  );
  const row = rows.rows[0];
  if (!row) throw new Error("Missing approved contribution");
  expect(
    (
      await ledger.transitionContribution(owner, {
        schemaVersion: 1,
        idempotencyKey: "demo-test-edit",
        contributionId: row.id as string,
        expectedRevision: row.revision as number,
        action: "correct",
        durationMinutes: 75,
        reason: "Synthetic review edit",
      })
    ).ok,
  ).toBe(true);
  const edited = await counts();
  expect(await seed()).toEqual({ created: false, profileVersion: 1 });
  expect(await counts()).toEqual(edited);
  expect(await ledger.summarize(owner)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 195, approvedContributions: 3 },
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("refuses production or missing explicit opt-in without creating product records", async () => {
  const before = await counts();
  await expect(
    seedProductDemo({ db, store: store() }, [], env),
  ).rejects.toThrow();
  await expect(
    seedProductDemo({ db, store: store() }, args, {
      NODE_ENV: "production",
      DEMO_MODE: "true",
    }),
  ).rejects.toThrow();
  await expect(
    seedProductDemo({ db, store: store() }, args, {
      NODE_ENV: "test",
      DEMO_MODE: "false",
    }),
  ).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("refuses a partially installed two-tenant manifest without overwriting remaining data", async () => {
  expect((await seed()).created).toBe(true);
  await db.execute(
    sql`delete from domain_command where organization_id='harbor' and idempotency_key='demo-product:v1:manifest'`,
  );
  const before = await counts();
  await expect(seed()).rejects.toThrow();
  expect(await counts()).toEqual(before);
  const markers = await db.execute(
    sql`select organization_id from domain_command where idempotency_key='demo-product:v1:manifest'`,
  );
  expect(markers.rows).toEqual([{ organization_id: "tidepath" }]);
});

it("refuses an occupied fixture source without altering it or installing partial records", async () => {
  const owner = await getContext("demo-owner", "tidepath");
  const sources = createSourceRepository({
    authorization,
    store: createSourceStore(db),
  });
  const source = {
    schemaVersion: 1 as const,
    organizationId: "tidepath",
    sourceId: "demo-product:v1:shared",
    revision: 1,
    channel: "web" as const,
    channelIdentity: "synthetic-conflict",
    externalMessageId: "occupied",
    idempotencyKey: "occupied",
    author: {
      externalIdentity: "demo-owner",
      membershipId: "tidepath-demo-owner",
    },
    occurredAt: null,
    receivedAt: "2026-11-04T00:00:00Z",
    timezone: "UTC",
    text: "Existing synthetic record",
    attachments: [],
    replyToSourceId: null,
    replacesRevision: null,
    original: { mediaType: "text/plain", payload: "Existing synthetic record" },
  };
  expect((await sources.accept(owner, source)).ok).toBe(true);
  const before = await counts();
  await expect(seed()).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(await sources.get(owner, source.sourceId, 1)).toMatchObject({
    ok: true,
    value: { text: "Existing synthetic record" },
  });
  expect(
    (
      await db.execute(
        sql`select 1 from domain_command where idempotency_key='demo-product:v1:manifest'`,
      )
    ).rows,
  ).toEqual([]);
});

it("refuses a partial identity roster before creating product data", async () => {
  await db.execute(sql`delete from account where id='demo-coordinator'`);
  const before = await counts();
  await expect(seed()).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect(
    (await db.execute(sql`select id from account where id='demo-coordinator'`))
      .rows,
  ).toEqual([]);
});

it("the composed CLI refuses production and default invocation before changing the database", async () => {
  const execute = promisify(execFile);
  const before = await counts();
  const common = {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ATTACHMENT_ROOT: root,
  };
  for (const [args, mode] of [
    [["--demo"], "production"],
    [[], "test"],
  ] as const) {
    try {
      await execute(process.execPath, ["scripts/seed-demo.ts", ...args], {
        env: { ...common, NODE_ENV: mode, DEMO_MODE: "true" },
      });
      throw new Error("Expected CLI refusal");
    } catch (error) {
      const failure = error as { code?: unknown; stderr?: string };
      expect(failure.code).not.toBe(0);
      expect(failure.stderr).toContain("Demo seed refused");
      expect(failure.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    }
  }
  expect(await counts()).toEqual(before);
});

it("the composed CLI creates and reuses the product profile in test mode", async () => {
  const execute = promisify(execFile);
  await resetAuthTables(db);
  const cliEnv = {
    ...process.env,
    NODE_ENV: "test",
    DEMO_MODE: "true",
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    ATTACHMENT_ROOT: root,
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "synthetic-integration-secret".padEnd(40, "x"),
  };
  const first = await execute(
    process.execPath,
    ["scripts/seed-demo.ts", "--demo"],
    { env: cliEnv },
  );
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("Synthetic demo ready");
  expect(first.stdout).toContain("created: true");
  expect(
    (
      await db.execute(
        sql`select count(*)::int as count from "user" where id like 'demo-%'`,
      )
    ).rows[0]?.count,
  ).toBe(5);
  const before = await counts();
  const second = await execute(
    process.execPath,
    ["scripts/seed-demo.ts", "--demo"],
    { env: cliEnv },
  );
  expect(second.stdout).toContain("created: false");
  expect(await counts()).toEqual(before);
});

it("workspace metadata is meaningful, tenant scoped and rechecks staff authority", async () => {
  await seed();
  const owner = await getContext("demo-owner", "tidepath");
  const volunteer = await getContext("demo-volunteer", "tidepath");
  const reader = await getContext("demo-reader", "tidepath");
  const activities = createWorkspaceActivityReader(db);
  const id = "demo-product:v1:activity-shared";
  await db.execute(
    sql`insert into activity(organization_id,id,revision,kind,local_date,date_precision,origin_kind,origin_reason) values ('harbor','other-tenant-activity',1,'Private other activity',null,'unknown','staff','Synthetic test')`,
  );
  const facts = await activities(owner, [id, id, "other-tenant-activity"]);
  expect(facts).toEqual([
    { activityId: id, kind: "visit", localDate: "2026-11-06" },
  ]);
  expect(await activities(volunteer, [id])).toEqual([]);
  expect(await activities(reader, [id])).toEqual([]);
  const processing = createProcessingRepository(db);
  const own = await processing.listSourceStatuses(volunteer);
  expect(own.ok).toBe(true);
  if (!own.ok) throw new Error("Own updates unavailable");
  expect(
    own.value.some(
      (row) =>
        row.sourceId === "demo-product:v1:shared-review" &&
        row.preview?.includes("Demo Volunteer") &&
        row.receivedAt === "2026-11-06T12:00:00.000Z",
    ),
  ).toBe(true);
  expect(
    own.value.some(
      (row) =>
        row.sourceId === "demo-product:v1:supplies" ||
        row.sourceId === "demo-product:v1:photo" ||
        row.sourceId === "demo-product:v1:harbor-message",
    ),
  ).toBe(false);
  expect(await processing.listSourceStatuses(reader)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  await db.execute(
    sql`update member set role='volunteer' where id='tidepath-demo-owner'`,
  );
  expect(await activities(owner, [id])).toEqual([]);
  const narrowed = await processing.listSourceStatuses(owner);
  expect(narrowed.ok).toBe(true);
  if (!narrowed.ok) throw new Error("Own source list unavailable");
  expect(narrowed.value.map((row) => row.sourceId)).toEqual([
    "demo-product:v1:supplies",
  ]);
  await db.execute(
    sql`update member set role='report-reader' where id='tidepath-demo-owner'`,
  );
  expect(await processing.listSourceStatuses(owner)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});

it("source summary previews disappear after evidence is redacted", async () => {
  await seed();
  const owner = await getContext("demo-owner", "tidepath");
  const volunteer = await getContext("demo-volunteer", "tidepath");
  const retention = createRetentionRepository(db, {
    now: () => new Date("2030-01-01T00:00:00Z"),
  });
  expect(
    await retention.redactSource(owner, {
      sourceId: "demo-product:v1:shared-review",
      expectedRevision: 1,
      idempotencyKey: "metadata-redact",
      reason: "Synthetic privacy test",
    }),
  ).toMatchObject({ ok: true });
  const processing = createProcessingRepository(db);
  for (const actor of [owner, volunteer]) {
    const rows = await processing.listSourceStatuses(actor);
    expect(rows.ok).toBe(true);
    if (!rows.ok) throw new Error("Source list unavailable");
    expect(
      rows.value.some(
        (row) => row.sourceId === "demo-product:v1:shared-review",
      ),
    ).toBe(false);
  }
});
