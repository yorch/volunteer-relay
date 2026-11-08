import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sharp: typeof import("../../../apps/web/node_modules/sharp/lib/index.js") =
  createRequire(new URL("../../../apps/web/package.json", import.meta.url))(
    "sharp",
  );

import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createProductExtensions,
  readPrivateBlob,
} from "../../../apps/web/lib/product/extensions.ts";
import { createProductHandler } from "../../../apps/web/lib/product/http.ts";
import {
  createDeterministicProvider,
  createExtractionService,
} from "../../../packages/ai/src/index.ts";
import type {
  SourceEnvelope,
  TenantContext,
} from "../../../packages/contracts/src/index.ts";
import {
  createAttachmentMetadataStore,
  createProcessingRepository,
  createSourceStore,
  sql,
} from "../../../packages/db/src/index.ts";
import { createAttachmentReader } from "../../../packages/domain/core/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
  systemContext,
} from "../domain/domain-support.ts";

let root: string;
let fixture: DomainFixture;
let staff: TenantContext;
let reader: TenantContext;
let other: TenantContext;
let handler: (request: Request) => Promise<Response>;
let sources: SourceEnvelope[];
let processing: ReturnType<typeof createProcessingRepository>;
let sourceRepo: ReturnType<typeof createSourceRepository>;

beforeAll(async () => {
  fixture = await openDomainFixture();
  root = await mkdtemp(join(tmpdir(), "relay-acceptance-"));
  staff = await context(fixture.authorization, "user-kai", "tidepath", "staff");
  reader = await context(
    fixture.authorization,
    "user-ren",
    "tidepath",
    "reader",
  );
  other = await context(fixture.authorization, "user-ive", "harbor", "other");
  sources = JSON.parse(
    await readFile("fixtures/sources.json", "utf8"),
  ) as SourceEnvelope[];
  processing = createProcessingRepository(fixture.db);
  sourceRepo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  const extension = createProductExtensions({
    db: fixture.db,
    authorization: fixture.authorization,
    sources: sourceRepo,
    processing,
    attachments: createAttachmentReader({
      authorization: fixture.authorization,
      metadata: createAttachmentMetadataStore(fixture.db),
      blobs: { read: (key) => readPrivateBlob(root, key) },
    }),
    root,
    maxBytes: 10485760,
  });
  handler = createProductHandler({
    appUrl: "http://localhost:3000",
    resolve: async (request) => {
      const selected =
        request.headers.get("x-test-role") === "reader"
          ? reader
          : request.headers.get("x-test-role") === "other"
            ? other
            : staff;
      if (selected.actor.kind !== "user") throw new Error("expected user");
      return {
        ok: true,
        value: {
          context: selected,
          organization: {
            organizationId: selected.organizationId,
            membershipId: selected.actor.membershipId,
            name: "Synthetic",
            slug: selected.organizationId,
            role: selected.actor.role,
          },
        },
      };
    },
    authorization: fixture.authorization,
    sources: sourceRepo,
    processing,
    ledger: fixture.ledger,
    needs: fixture.needs,
    members: async () => [],
    extensions: extension,
  });
});
afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
const get = (path: string, role = "staff") =>
  handler(
    new Request(`http://localhost:3000/api/product/${path}`, {
      headers: { "x-test-role": role },
    }),
  );
const post = (path: string, body: unknown) =>
  handler(
    new Request(`http://localhost:3000/api/product/${path}`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );

it("persists fixture sources through leases, extraction and staff review without counting rejected duplicates", async () => {
  const extractor = createExtractionService({
    provider: createDeterministicProvider(),
  });
  for (const source of sources.slice(0, 5)) {
    expect((await sourceRepo.accept(staff, source)).ok).toBe(true);
    const [lease] = await processing.pendingSources(1);
    expect(lease?.source.sourceId).toBe(source.sourceId);
    if (!lease) throw new Error("Missing lease");
    const extraction = await extractor.extract(
      systemContext("tidepath"),
      lease.source,
      { model: "fixture", prompt: "fixture", policy: "fixture" },
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) throw new Error("Extraction failed");
    expect(
      (
        await processing.persistProposal(
          systemContext("tidepath"),
          lease.source,
          extraction.value,
          lease.leaseToken,
        )
      ).ok,
    ).toBe(true);
    const decision = {
      runId: extraction.value.runId,
      expectedRevision: 1,
      idempotencyKey: `review-${source.sourceId}`,
      decision:
        source.sourceId === "source-01" || source.sourceId === "source-05"
          ? "accept"
          : "reject",
      reason: "Staff review",
    };
    const result = await post("review", decision);
    expect(result.status).toBe(200);
    expect((await post("review", decision)).status).toBe(200);
  }
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 60, approvedContributions: 1 },
  });
  const rows = await fixture.db.execute(
    sql`select status, duration_minutes from contribution order by duration_minutes nulls last`,
  );
  expect(rows.rows).toEqual([
    { status: "approved", duration_minutes: 60 },
    { status: "pending", duration_minutes: null },
  ]);
  const report = await get("reports");
  expect(await report.json()).toMatchObject({
    ok: true,
    value: {
      ledger: {
        approvedMinutes: 60,
        approvedContributions: 1,
        pendingUnknownDuration: 1,
      },
    },
  });
  const csv = await get("reports.csv");
  expect(csv.status).toBe(200);
  expect(await csv.text()).toContain('"60"');
});

it("conceals source detail and individual records across tenant and report-reader boundaries", async () => {
  expect(await processing.getSource(other, "source-01")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  const response = await get("workspace", "reader");
  const body = await response.json();
  expect(body).toMatchObject({
    ok: true,
    value: {
      sources: [],
      queue: [],
      contributions: [],
      needs: [],
      members: [],
    },
  });
  expect(JSON.stringify(body)).not.toContain("Mira and Sol");
  expect((await get("reports", "reader")).status).toBe(200);
});

it("rolls back an import batch when a later source collides", async () => {
  const entry = (id: string, text: string) => ({
    id,
    author: "Mira",
    text,
    timestamp: "2026-11-04T15:00:00Z",
  });
  const input = (rows: unknown[]) => ({
    format: "json",
    dateFormat: "ISO",
    timezone: "UTC",
    authorMapping: { Mira: "tidepath-mira" },
    text: JSON.stringify(rows),
  });
  expect(
    (await post("import", input([entry("existing", "Original")]))).status,
  ).toBe(200);
  const before = await fixture.db.execute(
    sql`select count(*)::int as count from source_revision`,
  );
  expect(
    (
      await post(
        "import",
        input([entry("fresh", "New row"), entry("existing", "Changed")]),
      )
    ).status,
  ).toBe(409);
  const after = await fixture.db.execute(
    sql`select count(*)::int as count from source_revision`,
  );
  expect(after.rows).toEqual(before.rows);
});

it("strips photo metadata and restricts private attachment reads", async () => {
  const original = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "synthetic-private-marker" } } })
    .toBuffer();
  expect((await sharp(original).metadata()).exif).toBeDefined();
  const form = new FormData();
  form.set("file", new File([original], "photo.jpg", { type: "image/jpeg" }));
  form.set("text", "Synthetic photo");
  form.set("idempotencyKey", "photo-key");
  const response = await handler(
    new Request("http://localhost:3000/api/product/source-photo", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      body: form,
    }),
  );
  expect(response.status).toBe(200);
  const receipt = (await response.json()) as { value: { sourceId: string } };
  const source = await processing.getSource(staff, receipt.value.sourceId);
  if (!source.ok || !source.value.attachments[0])
    throw new Error("Missing photo");
  const attachment = source.value.attachments[0];
  const path = `attachments/${encodeURIComponent(source.value.sourceId)}/${encodeURIComponent(attachment.id)}`;
  const read = await get(path);
  expect(read.status).toBe(200);
  expect(
    (await sharp(Buffer.from(await read.arrayBuffer())).metadata()).exif,
  ).toBeUndefined();
  expect((await get(path, "other")).status).not.toBe(200);
  expect((await get(path, "reader")).status).not.toBe(200);
});

it("replays intake and review across repository restart and amends 60 minutes to 90", async () => {
  const input = {
    schemaVersion: 1,
    idempotencyKey: "revision-case",
    text: "Visited T-03 for 60 minutes on November 2.",
  };
  const receipt = await post("sources", input);
  expect(receipt.status).toBe(200);
  const id = ((await receipt.json()) as { value: { sourceId: string } }).value
    .sourceId;
  expect((await post("sources", input)).status).toBe(200);
  const stored = await processing.getSource(staff, id);
  if (!stored.ok) throw new Error("Missing submitted source");
  const extractor = createExtractionService({
    provider: createDeterministicProvider(),
  });
  const review = async (source: SourceEnvelope) => {
    const repository = createProcessingRepository(fixture.db);
    const [lease] = await repository
      .pendingSources(20)
      .then((leases) => leases.filter((item) => item.source.sourceId === id));
    if (!lease) throw new Error("Missing source lease");
    const proposal = await extractor.extract(
      systemContext("tidepath"),
      source,
      { model: "fixture", prompt: "fixture", policy: "fixture" },
    );
    if (!proposal.ok) throw new Error("Extraction failed");
    expect(
      (
        await repository.persistProposal(
          systemContext("tidepath"),
          source,
          proposal.value,
          lease.leaseToken,
        )
      ).ok,
    ).toBe(true);
    const decision = {
      runId: proposal.value.runId,
      expectedRevision: 1,
      idempotencyKey: `revision-review-${source.revision}`,
      decision: "accept",
      reason: "Confirmed",
    };
    expect((await post("review", decision)).status).toBe(200);
    expect((await post("review", decision)).status).toBe(200);
  };
  await review(stored.value);
  const text = "Visited T-03 for 90 minutes on November 2.";
  const revised = {
    ...stored.value,
    revision: 2,
    replacesRevision: 1,
    idempotencyKey: "revision-case-2",
    text,
    original: { mediaType: "text/plain", payload: text },
  };
  expect((await sourceRepo.accept(staff, revised)).ok).toBe(true);
  await review(revised);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 150, approvedContributions: 2 },
  });
  // The live contribution is updated once; replay does not create another record.
  const counts = await fixture.db.execute(
    sql`select duration_minutes, revision from contribution where origin_source_id=${id}`,
  );
  expect(counts.rows).toEqual([{ duration_minutes: 90, revision: 2 }]);
});
