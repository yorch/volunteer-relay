import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProductExtensions } from "../../../apps/web/lib/product/extensions.ts";
import { createProductHandler } from "../../../apps/web/lib/product/http.ts";
import { createFilesystemBlobStore } from "../../../packages/blob/src/index.ts";
import type { TenantContext } from "../../../packages/contracts/src/index.ts";
import {
  createAttachmentMetadataStore,
  createProcessingRepository,
  createSourceStore,
  sql,
} from "../../../packages/db/src/index.ts";
import { createAttachmentReader } from "../../../packages/domain/core/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import { readPrivateBlob } from "../../../packages/intake/src/index.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
} from "../domain/domain-support.ts";

// DB-backed: requires TEST_DATABASE_URL naming a disposable *_test database.
const APP = "http://localhost:3000";
let fixture: DomainFixture;
let root: string;
let handler: (request: Request) => Promise<Response>;
let processing: ReturnType<typeof createProcessingRepository>;
const actors: Record<string, TenantContext> = {};

beforeAll(async () => {
  fixture = await openDomainFixture();
  // The blob store refuses a symlinked root (macOS tmpdir is one).
  root = await realpath(await mkdtemp(join(tmpdir(), "relay-demo-replay-")));
  actors.coordinator = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "replay-kai",
  );
  actors.volunteer = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "replay-mira",
  );
  actors.reader = await context(
    fixture.authorization,
    "user-ren",
    "tidepath",
    "replay-ren",
  );
  actors.harbor = await context(
    fixture.authorization,
    "user-ive",
    "harbor",
    "replay-ive",
  );
  const store = createFilesystemBlobStore({ root });
  const sources = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  processing = createProcessingRepository(fixture.db);
  const extensions = createProductExtensions({
    db: fixture.db,
    authorization: fixture.authorization,
    sources,
    processing,
    attachments: createAttachmentReader({
      authorization: fixture.authorization,
      metadata: createAttachmentMetadataStore(fixture.db),
      blobs: { read: (key) => store.read(key) },
    }),
    store,
    maxBytes: 1048576,
  });
  handler = createProductHandler({
    appUrl: APP,
    authorization: fixture.authorization,
    sources,
    processing,
    ledger: fixture.ledger,
    needs: fixture.needs,
    members: async () => [],
    extensions,
    // The session decides the tenant; the request body never does.
    resolve: async (request) => {
      const selected = actors[request.headers.get("x-test-actor") ?? ""];
      if (selected?.actor.kind !== "user")
        throw new Error("Unknown test actor");
      return {
        ok: true,
        value: {
          context: selected,
          organization: {
            organizationId: selected.organizationId,
            membershipId: selected.actor.membershipId,
            role: selected.actor.role,
            name: selected.organizationId,
            slug: selected.organizationId,
          },
        },
      };
    },
  });
}, 60000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const replay = (actor: string, body: Record<string, unknown>) =>
  handler(
    new Request(`${APP}/api/product/demo-replay`, {
      method: "POST",
      headers: {
        origin: APP,
        "content-type": "application/json",
        "x-test-actor": actor,
      },
      body: JSON.stringify(body),
    }),
  );
const probe = async (actor: string) =>
  (
    (await (
      await handler(
        new Request(`${APP}/api/product/demo-replay`, {
          headers: { "x-test-actor": actor },
        }),
      )
    ).json()) as { value: { enabled: boolean } }
  ).value.enabled;
type Replayed = {
  value: { sourceId: string; revision: number; proposal: string };
};
async function sourceCount() {
  const rows = await fixture.db.execute(
    sql`select count(*)::int as count from source_revision where channel_identity='demo-replay'`,
  );
  return Number(rows.rows[0]?.count ?? 0);
}

describe("demo sample replay", () => {
  it("is absent outside demo mode and in production", async () => {
    vi.stubEnv("DEMO_MODE", "false");
    vi.stubEnv("NODE_ENV", "test");
    const body = { sampleId: "spanish-update", idempotencyKey: "off" };
    expect((await replay("coordinator", body)).status).toBe(404);
    expect(await probe("coordinator")).toBe(false);
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect((await replay("coordinator", body)).status).toBe(404);
    expect(await probe("coordinator")).toBe(false);
    expect(await sourceCount()).toBe(0);
  }, 30000);

  it("denies volunteers and report readers in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "test");
    const body = { sampleId: "spanish-update", idempotencyKey: "denied" };
    expect((await replay("volunteer", body)).status).toBe(403);
    expect((await replay("reader", body)).status).toBe(403);
    expect(await probe("volunteer")).toBe(false);
    expect(await probe("reader")).toBe(false);
    expect(await probe("coordinator")).toBe(true);
    expect(await sourceCount()).toBe(0);
  }, 30000);

  it("creates a source and a pending review case, idempotently, that the normal review flow decides", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "test");
    const body = { sampleId: "spanish-update", idempotencyKey: "first" };
    const first = await replay("coordinator", body);
    expect(first.status).toBe(200);
    const created = ((await first.json()) as Replayed).value;
    expect(created.sourceId).toMatch(/^replay:[a-f0-9]{64}$/);
    expect(created.proposal).toBe("review");
    const coordinator = actors.coordinator as TenantContext;
    const stored = await processing.getSource(coordinator, created.sourceId);
    if (!stored.ok) throw new Error(stored.error.code);
    expect(stored.value).toMatchObject({
      organizationId: "tidepath",
      channel: "web",
      channelIdentity: "demo-replay",
      author: { membershipId: "tidepath-kai" },
      attachments: [],
    });
    const queue = await processing.listQueue(coordinator);
    if (!queue.ok) throw new Error(queue.error.code);
    const entry = queue.value.find(
      (item) => item.source.sourceId === created.sourceId,
    );
    expect(entry?.proposal).toMatchObject({
      modelVersion: "provider-free-rules-v1",
      items: [{ kind: "need", category: "food", urgency: "routine" }],
    });
    // The intake event was written with the source.
    const outbox = await fixture.db.execute(
      sql`select count(*)::int as count from outbox_event where organization_id='tidepath' and aggregate_id=${created.sourceId}`,
    );
    expect(Number(outbox.rows[0]?.count)).toBe(1);

    const again = await replay("coordinator", body);
    expect(again.status).toBe(200);
    expect(((await again.json()) as Replayed).value).toEqual(created);
    expect(await sourceCount()).toBe(1);
    const runs = await fixture.db.execute(
      sql`select count(*)::int as count from extraction_run where organization_id='tidepath' and source_id=${created.sourceId}`,
    );
    expect(Number(runs.rows[0]?.count)).toBe(1);

    if (!entry) throw new Error("Missing review case");
    const decided = await processing.decide(coordinator, {
      runId: entry.proposal.runId,
      expectedRevision: entry.revision,
      idempotencyKey: "replay-accept",
      decision: "accept",
      reason: "Demo replay review",
    });
    expect(decided.ok).toBe(true);

    // A fresh key replays the same sample as a new source.
    const fresh = await replay("coordinator", {
      sampleId: "spanish-update",
      idempotencyKey: "second",
    });
    expect(((await fresh.json()) as Replayed).value.sourceId).not.toBe(
      created.sourceId,
    );
    expect(await sourceCount()).toBe(2);
  }, 30000);

  it("stores the synthetic photo privately and leaves hours unknown", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "test");
    const body = { sampleId: "supplies-photo", idempotencyKey: "photo" };
    const response = await replay("coordinator", body);
    expect(response.status).toBe(200);
    const created = ((await response.json()) as Replayed).value;
    expect(created.proposal).toBe("review");
    const stored = await processing.getSource(
      actors.coordinator as TenantContext,
      created.sourceId,
    );
    if (!stored.ok) throw new Error(stored.error.code);
    const attachment = stored.value.attachments[0];
    expect(attachment).toMatchObject({
      mimeType: "image/png",
      organizationId: "tidepath",
    });
    if (!attachment) throw new Error("Missing attachment");
    expect(await readPrivateBlob(root, attachment.storageKey)).not.toBeNull();
    const queue = await processing.listQueue(
      actors.coordinator as TenantContext,
    );
    if (!queue.ok) throw new Error(queue.error.code);
    const entry = queue.value.find(
      (item) => item.source.sourceId === created.sourceId,
    );
    expect(
      entry?.proposal.items.find((item) => item.kind === "contribution"),
    ).toMatchObject({ durationMinutes: null });
    const repeat = await replay("coordinator", body);
    expect(((await repeat.json()) as Replayed).value).toEqual(created);
  }, 30000);

  it("keeps each organization's replays separate", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "test");
    const body = { sampleId: "urgent-need", idempotencyKey: "shared-key" };
    const tide = (
      (await (await replay("coordinator", body)).json()) as Replayed
    ).value;
    const harbor = ((await (await replay("harbor", body)).json()) as Replayed)
      .value;
    expect(harbor.sourceId).not.toBe(tide.sourceId);
    const harborActor = actors.harbor as TenantContext;
    expect(
      await processing.getSource(harborActor, tide.sourceId),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const harborQueue = await processing.listQueue(harborActor);
    if (!harborQueue.ok) throw new Error(harborQueue.error.code);
    expect(
      harborQueue.value.every(
        (item) => item.source.organizationId === "harbor",
      ),
    ).toBe(true);
    expect(harborQueue.value.map((item) => item.source.sourceId)).toEqual([
      harbor.sourceId,
    ]);
    const tideQueue = await processing.listQueue(
      actors.coordinator as TenantContext,
    );
    if (!tideQueue.ok) throw new Error(tideQueue.error.code);
    expect(tideQueue.value.map((item) => item.source.sourceId)).not.toContain(
      harbor.sourceId,
    );
  }, 30000);
});
