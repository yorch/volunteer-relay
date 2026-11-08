import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { SourceEnvelope } from "../../../packages/contracts/src/index.ts";
import {
  createAttachmentMetadataStore,
  createRetentionRepository,
  createSourceStore,
  sql,
} from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { createAttachmentReader } from "../../../packages/domain/core/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import {
  createPrivateFilesystemBlobStore,
  erasePrivateBlob,
  readPrivateBlob,
} from "../../../packages/intake/src/index.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  context,
  openDomainFixture,
  seedDomainMembers,
} from "../domain/domain-support.ts";

const execute = promisify(execFile);

it("erases the real private blob and reapplies an authenticated ledger to an older snapshot", async () => {
  const fixture = await openDomainFixture();
  const root = await mkdtemp(join(tmpdir(), "relay-privacy-"));
  const ledgerPath = join(root, "ledger.json");
  const tamperedPath = join(root, "tampered.json");
  try {
    await fixture.db.execute(
      sql`truncate blob_erasure_attempt,blob_erasure_job`,
    );
    const blobRoot = join(root, "blobs");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=",
      "base64",
    );
    const metadata = await createPrivateFilesystemBlobStore(blobRoot).put(png);
    const source: SourceEnvelope = {
      schemaVersion: 1,
      organizationId: "tidepath",
      sourceId: "private-test-source",
      revision: 1,
      channel: "web",
      channelIdentity: "private-test",
      externalMessageId: "private-test",
      idempotencyKey: "private-test",
      author: { externalIdentity: "Mira", membershipId: "tidepath-mira" },
      occurredAt: null,
      receivedAt: "2025-01-01T00:00:00Z",
      timezone: "UTC",
      text: "Synthetic private visit",
      attachments: [{ ...metadata, id: "photo", organizationId: "tidepath" }],
      replyToSourceId: null,
      replacesRevision: null,
      original: { mediaType: "text/plain", payload: "Synthetic private visit" },
    };
    const author = await context(
      fixture.authorization,
      "user-mira",
      "tidepath",
      "source",
    );
    const staff = await context(
      fixture.authorization,
      "user-kai",
      "tidepath",
      "staff",
    );
    const owner = await context(
      fixture.authorization,
      "user-rae",
      "tidepath",
      "owner",
    );
    const sources = createSourceRepository({
      authorization: fixture.authorization,
      store: createSourceStore(fixture.db),
    });
    const seed = async () => {
      expect((await sources.accept(author, source)).ok).toBe(true);
      const recorded = await fixture.ledger.recordActivity(staff, {
        schemaVersion: 1,
        idempotencyKey: "private-activity",
        kind: "visit",
        localDate: "2025-01-01",
        datePrecision: "day",
        beneficiaryReference: "Synthetic private household",
        origin: {
          kind: "source",
          sourceId: source.sourceId,
          sourceRevision: 1,
        },
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      });
      if (!recorded.ok || !recorded.value.contributions[0])
        throw new Error("Could not record activity");
      expect(
        (
          await fixture.ledger.transitionContribution(staff, {
            schemaVersion: 1,
            idempotencyKey: "private-approve",
            contributionId: recorded.value.contributions[0].contributionId,
            expectedRevision: 1,
            action: "approve",
          })
        ).ok,
      ).toBe(true);
    };
    await seed();
    const reader = createAttachmentReader({
      authorization: fixture.authorization,
      metadata: createAttachmentMetadataStore(fixture.db),
      blobs: { read: (key) => readPrivateBlob(blobRoot, key) },
    });
    expect((await reader.read(staff, source.sourceId, "photo")).ok).toBe(true);
    const retention = createRetentionRepository(fixture.db, {
      now: () => new Date("2028-01-01T00:00:00Z"),
    });
    expect(await retention.previewExpiredEvidence(owner)).toMatchObject({
      ok: true,
      value: { sources: [{ sourceId: source.sourceId }] },
    });
    expect(
      (
        await retention.redactSource(owner, {
          sourceId: source.sourceId,
          expectedRevision: 1,
          idempotencyKey: "privacy-redact",
          reason: "Retention expired",
        })
      ).ok,
    ).toBe(true);
    expect(await reader.read(staff, source.sourceId, "photo")).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    const [job] = await retention.claimErasureJobs(10);
    if (!job) throw new Error("Missing erasure job");
    expect(
      await retention.runErasureJob(job, (key, digest) =>
        erasePrivateBlob(blobRoot, key, digest),
      ),
    ).toBe(true);
    expect(await readPrivateBlob(blobRoot, metadata.storageKey)).toBeNull();
    expect(await fixture.ledger.summarize(staff)).toMatchObject({
      ok: true,
      value: { approvedMinutes: 60, approvedContributions: 1 },
    });
    const env = {
      ...process.env,
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      RETENTION_LEDGER_KEY: "synthetic-key-for-private-tests-only-00000000",
    };
    await execute(
      process.execPath,
      ["scripts/retention.ts", "export-all", "--file", ledgerPath],
      { env },
    );
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(ledger.records).toHaveLength(1);
    ledger.records[0].record.sourceDigest = "0".repeat(64);
    await writeFile(tamperedPath, JSON.stringify(ledger), { mode: 0o600 });
    // Rebuild the older state in the same isolated database, then verify that an
    // invalid manifest cannot redact it before the genuine ledger is applied.
    await resetAuthTables(fixture.db);
    await seedOrganizations(fixture.db);
    await seedDomainMembers(fixture.db);
    await seed();
    await expect(
      execute(
        process.execPath,
        ["scripts/retention.ts", "restore-all", "--file", tamperedPath],
        { env },
      ),
    ).rejects.toThrow();
    expect((await sources.get(author, source.sourceId, 1)).ok).toBe(true);
    await execute(
      process.execPath,
      ["scripts/retention.ts", "restore-all", "--file", ledgerPath],
      { env },
    );
    expect(await sources.get(author, source.sourceId, 1)).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await fixture.ledger.summarize(staff)).toMatchObject({
      ok: true,
      value: { approvedMinutes: 60, approvedContributions: 1 },
    });
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
