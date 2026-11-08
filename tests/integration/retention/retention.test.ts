import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type {
  ExtractionProposal,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import {
  createAttachmentMetadataStore,
  createProcessingRepository,
  createRetentionRepository,
  createSourceStore,
  schema,
  sql,
} from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
  seedDomainMembers,
  systemContext,
} from "../domain/domain-support.ts";

let fixture: DomainFixture;
const hash = "a".repeat(64);
const key = `aa/${hash}`;
const source: SourceEnvelope = {
  schemaVersion: 1,
  organizationId: "tidepath",
  sourceId: "sensitive-source",
  revision: 1,
  channel: "web",
  channelIdentity: "web",
  externalMessageId: "external",
  idempotencyKey: "source",
  author: { externalIdentity: "Private name", membershipId: "tidepath-mira" },
  occurredAt: null,
  receivedAt: "2026-01-01T00:00:00Z",
  timezone: "UTC",
  text: "Sensitive person needs food",
  attachments: [
    {
      id: "picture",
      organizationId: "tidepath",
      storageKey: key,
      sha256: hash,
      mimeType: "image/png",
      bytes: 100,
    },
  ],
  replyToSourceId: null,
  replacesRevision: null,
  original: { mediaType: "text/plain", payload: "Sensitive person needs food" },
};
const evidence = [
  {
    kind: "text" as const,
    field: "activity",
    sourceId: source.sourceId,
    sourceRevision: 1,
    start: 0,
    end: 9,
    quote: "Sensitive",
  },
];
const proposal: ExtractionProposal = {
  schemaVersion: 1,
  organizationId: "tidepath",
  sourceId: source.sourceId,
  sourceRevision: 1,
  runId: "run-private",
  modelVersion: "model",
  promptVersion: "prompt",
  policyVersion: "1",
  items: [
    {
      kind: "activity",
      key: "private-key",
      activityKind: "visit",
      localDate: "2026-01-01",
      datePrecision: "day",
      beneficiaryReference: "Sensitive person",
      evidence,
    },
    {
      kind: "contribution",
      key: "private-contribution",
      activityKey: "private-key",
      membershipId: "tidepath-mira",
      durationMinutes: 60,
      evidence,
    },
    {
      kind: "need",
      key: "private-need",
      category: "food",
      urgency: "urgent",
      summary: "Sensitive person needs food",
      provisional: false,
      evidence,
    },
  ],
  unresolved: [],
};
const retention = () =>
  createRetentionRepository(fixture.db, {
    now: () => new Date("2028-01-01T00:00:00Z"),
  });
async function seedSource() {
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const repo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await repo.accept(mira, source)).ok).toBe(true);
  return { repo, mira };
}
beforeAll(async () => {
  fixture = await openDomainFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
  await fixture.db.execute(sql`truncate blob_erasure_attempt,blob_erasure_job`);
});
it("redacts evidence and derived private fields while preserving approved totals and immutable history", async () => {
  const { repo: sourceRepo, mira } = await seedSource();
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const processing = createProcessingRepository(fixture.db);
  const [lease] = await processing.pendingSources(1);
  if (!lease) throw new Error("lease");
  expect(
    (
      await processing.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await processing.decide(staff, {
        runId: proposal.runId,
        expectedRevision: 1,
        idempotencyKey: "review",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  const repo = retention();
  expect(await repo.previewExpiredEvidence(staff)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(await repo.previewExpiredEvidence(owner)).toMatchObject({
    ok: true,
    value: { sources: [{ sourceId: source.sourceId, latestRevision: 1 }] },
  });
  const command = {
    sourceId: source.sourceId,
    expectedRevision: 1,
    idempotencyKey: "redact",
    reason: "Retention period expired",
  };
  const first = await repo.redactSource(owner, command);
  expect(first.ok).toBe(true);
  expect(await repo.redactSource(owner, command)).toEqual(first);
  expect(await sourceRepo.get(mira, source.sourceId, 1)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await sourceRepo.accept(mira, source)).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
  expect(
    await createAttachmentMetadataStore(fixture.db).find(
      "tidepath",
      source.sourceId,
      "picture",
    ),
  ).toBeNull();
  expect(await processing.getSource(staff, source.sourceId)).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  expect(await processing.listQueue(staff)).toEqual({ ok: true, value: [] });
  expect(await processing.pendingSources(10)).toEqual([]);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 60, approvedContributions: 1 },
  });
  const rows = await fixture.db.execute(
    sql`select (select envelope::text from source_revision limit 1) envelope,(select proposal::text from extraction_run limit 1) proposal,(select summary from need limit 1) summary,(select beneficiary_reference from activity limit 1) beneficiary,(select string_agg(after::text,' ') from domain_audit_event) audit`,
  );
  expect(rows.rows[0]).toMatchObject({
    envelope: '{"redacted": true}',
    proposal: '{"redacted": true}',
    summary: "[redacted]",
    beneficiary: null,
  });
  expect(JSON.stringify(rows.rows[0])).not.toContain("Sensitive person");
  await expect(
    fixture.db.execute(sql`update source_revision set text_body='forged'`),
  ).rejects.toThrow();
  await expect(
    fixture.db.execute(sql`update source_redaction set reason='forged'`),
  ).rejects.toThrow();
  const jobs = await repo.claimErasureJobs(10);
  expect(jobs).toHaveLength(1);
  const job = jobs[0];
  if (!job) throw new Error("job");
  let erased = "";
  expect(
    await repo.runErasureJob(job, async (storageKey) => {
      erased = storageKey;
    }),
  ).toBe(true);
  expect(erased).toBe(key);
  expect(await repo.runErasureJob(job, async () => {})).toBe(false);
});
it("rechecks shared blob references across tenants under the erasure lock", async () => {
  await seedSource();
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const repo = retention();
  expect(
    (
      await repo.redactSource(owner, {
        sourceId: source.sourceId,
        expectedRevision: 1,
        idempotencyKey: "r",
        reason: "expired",
      })
    ).ok,
  ).toBe(true);
  const [job] = await repo.claimErasureJobs(1);
  if (!job) throw new Error("missing job");
  const nico = await context(
    fixture.authorization,
    "user-nico",
    "harbor",
    "source",
  );
  const sources = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  const second: SourceEnvelope = {
    ...source,
    organizationId: "harbor",
    sourceId: "harbor-source",
    channelIdentity: "harbor-web",
    externalMessageId: "harbor-external",
    idempotencyKey: "harbor-source",
    author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
    attachments: [
      {
        ...(source.attachments[0] as NonNullable<
          (typeof source.attachments)[0]
        >),
        organizationId: "harbor",
      },
    ],
  };
  expect((await sources.accept(nico, second)).ok).toBe(true);
  let called = false;
  expect(
    await repo.runErasureJob(job, async () => {
      called = true;
    }),
  ).toBe(false);
  expect(called).toBe(false);
  await fixture.db.insert(schema.user).values({
    id: "harbor-owner-user",
    name: "Owner",
    email: "harbor-owner@example.invalid",
  });
  await fixture.db.insert(schema.member).values({
    id: "harbor-owner",
    organizationId: "harbor",
    userId: "harbor-owner-user",
    role: "owner",
  });
  const harborOwner = await context(
    fixture.authorization,
    "harbor-owner-user",
    "harbor",
    "owner",
  );
  expect(
    (
      await repo.redactSource(harborOwner, {
        sourceId: "harbor-source",
        expectedRevision: 1,
        idempotencyKey: "r2",
        reason: "expired",
      })
    ).ok,
  ).toBe(true);
  const [next] = await repo.claimErasureJobs(1);
  if (!next) throw new Error("missing eligible job");
  expect(
    await repo.runErasureJob(next, async () => {
      called = true;
    }),
  ).toBe(true);
  expect(called).toBe(true);
});
it("rejects premature, stale and unsigned restore requests", async () => {
  await seedSource();
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const early = createRetentionRepository(fixture.db, {
    now: () => new Date("2026-02-01T00:00:00Z"),
  });
  expect(
    await early.redactSource(owner, {
      sourceId: source.sourceId,
      expectedRevision: 1,
      idempotencyKey: "early",
      reason: "request",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  const repo = retention();
  expect(
    await repo.redactSource(owner, {
      sourceId: source.sourceId,
      expectedRevision: 2,
      idempotencyKey: "stale",
      reason: "expired",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(
    (
      await repo.redactSource(owner, {
        sourceId: source.sourceId,
        expectedRevision: 1,
        idempotencyKey: "done",
        reason: "expired",
      })
    ).ok,
  ).toBe(true);
  const records = await repo.listRedactionLedger(owner);
  if (!records.ok || !records.value[0]) throw new Error("missing ledger");
  const record = records.value[0];
  expect(JSON.stringify(record)).not.toContain("expired");
  expect(await repo.restoreRedactionLedger(record, "unsigned")).toMatchObject({
    ok: false,
    error: { code: "VALIDATION" },
  });
  const verified = createRetentionRepository(fixture.db, {
    verifyRedactionLedger: (_record, signature) => signature === "valid",
  });
  expect(await verified.restoreRedactionLedger(record, "bad")).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expect(await verified.restoreRedactionLedger(record, "valid")).toEqual({
    ok: true,
    value: undefined,
  });
});
it("reapplies a verified ledger to a restored older backup without exposing raw evidence", async () => {
  await seedSource();
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const repo = retention();
  expect(
    (
      await repo.redactSource(owner, {
        sourceId: source.sourceId,
        expectedRevision: 1,
        idempotencyKey: "redact",
        reason: "expired",
      })
    ).ok,
  ).toBe(true);
  const list = await repo.listRedactionLedger(owner);
  if (!list.ok || !list.value[0]) throw new Error("ledger missing");
  const record = list.value[0];
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
  const restored = await seedSource();
  const verifier = createRetentionRepository(fixture.db, {
    now: () => new Date("2028-01-02T00:00:00Z"),
    verifyRedactionLedger: (_record, signature) => signature === "verified",
  });
  expect(
    await verifier.restoreRedactionLedger(
      { ...record, sourceDigest: "0".repeat(64) },
      "verified",
    ),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(await verifier.restoreRedactionLedger(record, "verified")).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await verifier.restoreRedactionLedger(record, "verified")).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    await restored.repo.get(restored.mira, source.sourceId, 1),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});
it("redacts source-linked command and audit snapshots without changing ledger minutes", async () => {
  await seedSource();
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
  const recorded = await fixture.ledger.recordActivity(staff, {
    schemaVersion: 1,
    idempotencyKey: "source-activity",
    kind: "Sensitive private visit",
    localDate: "2026-01-01",
    datePrecision: "day",
    beneficiaryReference: "Sensitive person",
    origin: { kind: "source", sourceId: source.sourceId, sourceRevision: 1 },
    contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error("record failed");
  expect(
    (
      await retention().redactSource(owner, {
        sourceId: source.sourceId,
        expectedRevision: 1,
        idempotencyKey: "redact",
        reason: "expired",
      })
    ).ok,
  ).toBe(true);
  const stored = await fixture.db.execute(
    sql`select result::text from domain_command where idempotency_key='source-activity'`,
  );
  expect(JSON.stringify(stored.rows)).not.toContain("Sensitive");
  const audit = await fixture.db.execute(
    sql`select before::text,after::text from domain_audit_event`,
  );
  expect(JSON.stringify(audit.rows)).not.toContain("Sensitive");
});
it("database write fences reject new evidence on a redacted source", async () => {
  await seedSource();
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  expect(
    (
      await retention().redactSource(owner, {
        sourceId: source.sourceId,
        expectedRevision: 1,
        idempotencyKey: "r",
        reason: "expired",
      })
    ).ok,
  ).toBe(true);
  await expect(
    fixture.db.execute(
      sql`insert into source_revision (organization_id,source_id,revision,channel,channel_identity,external_message_id,idempotency_key,author_external_identity,author_membership_id,occurred_at,received_at,timezone,text_body,original_media_type,original_payload,reply_to_source_id,replaces_revision,canonical_digest,envelope,correlation_id) select organization_id,source_id,2,channel,channel_identity,external_message_id,'replay-key',author_external_identity,author_membership_id,occurred_at,received_at,timezone,text_body,original_media_type,original_payload,reply_to_source_id,1,canonical_digest,envelope,correlation_id from source_revision where organization_id='tidepath' and source_id='sensitive-source'`,
    ),
  ).rejects.toThrow();
  await expect(
    fixture.db.execute(
      sql`insert into extraction_run(organization_id,run_id,source_id,source_revision,proposal) values ('tidepath','new-run','sensitive-source',1,'{}'::jsonb)`,
    ),
  ).rejects.toThrow();
  await expect(
    fixture.db.execute(
      sql`insert into source_attachment_identity(organization_id,source_id,attachment_id,storage_key,sha256,mime_type,bytes) values ('tidepath','sensitive-source','other','other',${hash},'image/png',1)`,
    ),
  ).rejects.toThrow();
  await expect(
    fixture.db.execute(
      sql`insert into source_attachment(organization_id,source_id,revision,attachment_id) values ('tidepath','sensitive-source',1,'picture')`,
    ),
  ).rejects.toThrow();
});
