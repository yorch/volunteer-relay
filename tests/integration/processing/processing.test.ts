import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type {
  ExtractionProposal,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import {
  createProcessingRepository,
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
const source: SourceEnvelope = {
  schemaVersion: 1,
  organizationId: "tidepath",
  sourceId: "s1",
  revision: 1,
  channel: "web",
  channelIdentity: "web",
  externalMessageId: "e1",
  idempotencyKey: "s1",
  author: { externalIdentity: "Mira", membershipId: "tidepath-mira" },
  occurredAt: null,
  receivedAt: "2026-11-04T15:01:00Z",
  timezone: "UTC",
  text: "Helped for an hour",
  attachments: [],
  replyToSourceId: null,
  replacesRevision: null,
  original: { mediaType: "text/plain", payload: "Helped for an hour" },
};
const evidence = [
  {
    kind: "text" as const,
    field: "activity",
    sourceId: "s1",
    sourceRevision: 1,
    start: 0,
    end: 6,
    quote: "Helped",
  },
];
const proposal: ExtractionProposal = {
  schemaVersion: 1,
  organizationId: "tidepath",
  sourceId: "s1",
  sourceRevision: 1,
  runId: "r1",
  modelVersion: "model",
  promptVersion: "prompt",
  policyVersion: "policy",
  unresolved: [],
  items: [
    {
      kind: "activity",
      key: "a",
      activityKind: "visit",
      localDate: null,
      datePrecision: "unknown",
      beneficiaryReference: null,
      evidence,
    },
    {
      kind: "contribution",
      key: "c",
      activityKey: "a",
      membershipId: "tidepath-mira",
      durationMinutes: 60,
      evidence,
    },
    {
      kind: "need",
      key: "n",
      category: "food",
      urgency: "urgent",
      summary: "Food",
      provisional: false,
      evidence,
    },
  ],
};
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
  const repo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "s",
  );
  expect((await repo.accept(mira, source)).ok).toBe(true);
});
it("persists review and applies once with audit, events, and live authorization", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  expect(await repo.pendingSources(10)).toEqual([source]);
  expect(
    (await repo.persistProposal(systemContext("tidepath"), source, proposal))
      .ok,
  ).toBe(true);
  expect((await repo.listQueue(staff)).ok).toBe(true);
  const command = {
    runId: "r1",
    expectedRevision: 1,
    idempotencyKey: "decision",
    decision: "accept" as const,
    reason: "confirmed",
  };
  const [a, b] = await Promise.all([
    repo.decide(staff, command),
    repo.decide(staff, command),
  ]);
  expect(a).toEqual({ ok: true, value: { revision: 2 } });
  expect(b).toEqual(a);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 60, approvedContributions: 1 },
  });
  const counts = await fixture.db.execute(
    sql`select (select count(*)::int from domain_audit_event) audit,(select count(*)::int from outbox_event where type='need.changed') need_events,(select count(*)::int from review_decision) decisions`,
  );
  expect(counts.rows[0]).toEqual({ audit: 3, need_events: 1, decisions: 1 });
  await fixture.db
    .delete(schema.member)
    .where(sql`${schema.member.id}='tidepath-kai'`);
  expect(await repo.decide(staff, command)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});
it("rejects forged evidence and rolls back a failed decision", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  await repo.pendingSources(10);
  const forged = structuredClone(proposal);
  const forgedItem = forged.items[0];
  const firstEvidence = evidence[0];
  if (!forgedItem || !firstEvidence)
    throw new Error("fixture missing evidence");
  forgedItem.evidence[0] = { ...firstEvidence, quote: "forged" };
  expect(
    await repo.persistProposal(systemContext("tidepath"), source, forged),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  const invalid = structuredClone(proposal);
  const c = invalid.items[1];
  if (c?.kind === "contribution") c.membershipId = "missing";
  expect(
    (await repo.persistProposal(systemContext("tidepath"), source, invalid)).ok,
  ).toBe(true);
  expect(
    await repo.decide(staff, {
      runId: "r1",
      expectedRevision: 1,
      idempotencyKey: "bad",
      decision: "accept",
      reason: "",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  const counts = await fixture.db.execute(
    sql`select (select count(*)::int from activity) activities,(select count(*)::int from review_decision) decisions`,
  );
  expect(counts.rows[0]).toEqual({ activities: 0, decisions: 0 });
});
it("hides evidence from other tenants and refuses stale proposals", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const other = await context(
    fixture.authorization,
    "user-ive",
    "harbor",
    "review",
  );
  expect(await repo.getSource(other, "s1")).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
  await repo.pendingSources(10);
  expect(
    (await repo.persistProposal(systemContext("tidepath"), source, proposal))
      .ok,
  ).toBe(true);
  const sourceRepo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  const revised = {
    ...source,
    revision: 2,
    replacesRevision: 1,
    idempotencyKey: "s2",
    text: "Changed",
    original: { mediaType: "text/plain", payload: "Changed" },
  };
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  expect((await sourceRepo.accept(mira, revised)).ok).toBe(true);
  expect(await repo.listQueue(staff)).toEqual({ ok: true, value: [] });
  expect(
    await repo.decide(staff, {
      runId: "r1",
      expectedRevision: 1,
      idempotencyKey: "stale",
      decision: "accept",
      reason: "",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  const count = await fixture.db.execute(
    sql`select count(*)::int as count from activity`,
  );
  expect(count.rows[0]?.count).toBe(0);
});
it("rolls back every effect when the outbox write fails", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  await repo.pendingSources(10);
  expect(
    (await repo.persistProposal(systemContext("tidepath"), source, proposal))
      .ok,
  ).toBe(true);
  await fixture.db.execute(
    sql`alter table outbox_event add constraint processing_test_outbox_failure check (type <> 'ledger.changed')`,
  );
  try {
    expect(
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "fail",
        decision: "accept",
        reason: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } });
    const result = await fixture.db.execute(
      sql`select (select count(*)::int from activity) activities,(select count(*)::int from contribution) contributions,(select count(*)::int from domain_audit_event) audits,(select count(*)::int from review_decision) decisions`,
    );
    expect(result.rows[0]).toEqual({
      activities: 0,
      contributions: 0,
      audits: 0,
      decisions: 0,
    });
    expect(await repo.listQueue(staff)).toMatchObject({
      ok: true,
      value: [{ revision: 1 }],
    });
  } finally {
    await fixture.db.execute(
      sql`alter table outbox_event drop constraint processing_test_outbox_failure`,
    );
  }
});
it("bounds retries and recovers expired leases without approving work", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect(await repo.pendingSources(1)).toEqual([source]);
    expect(await repo.pendingSources(1)).toEqual([]);
    await repo.markFailure(source);
    await fixture.db.execute(
      sql`update processing_work set retry_after=now()-interval '1 second'`,
    );
  }
  expect(await repo.pendingSources(1)).toEqual([]);
  expect(await repo.listSourceStatuses(staff)).toEqual({
    ok: true,
    value: [{ sourceId: "s1", revision: 1, status: "failed" }],
  });
  expect(await repo.listQueue(staff)).toEqual({ ok: true, value: [] });
});
it("records reasoned staff edits and retains the original proposal", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  await repo.pendingSources(1);
  expect(
    (await repo.persistProposal(systemContext("tidepath"), source, proposal))
      .ok,
  ).toBe(true);
  const items = structuredClone(proposal.items);
  const contribution = items[1];
  if (contribution?.kind !== "contribution")
    throw new Error("fixture missing contribution");
  contribution.durationMinutes = 90;
  expect(
    await repo.decide(staff, {
      runId: "r1",
      expectedRevision: 1,
      idempotencyKey: "edit",
      decision: "accept",
      reason: "Confirmed with volunteer",
      replacementItems: items,
    }),
  ).toEqual({ ok: true, value: { revision: 2 } });
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 90 },
  });
  const rows = await fixture.db.execute(
    sql`select r.proposal,d.command,(select count(*)::int from domain_audit_event where reason='Confirmed with volunteer') as edits from extraction_run r join review_decision d on r.organization_id=d.organization_id and r.run_id=d.run_id`,
  );
  expect(rows.rows[0]?.proposal).toEqual(proposal);
  expect(rows.rows[0]?.command).toMatchObject({
    reason: "Confirmed with volunteer",
    replacementItems: items,
  });
  expect(rows.rows[0]?.edits).toBe(3);
});
