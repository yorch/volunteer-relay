import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type {
  ExtractionProposal,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import {
  createFollowThroughRepository,
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
  policyVersion: "1",
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
      urgency: "routine",
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
  const [lease] = await repo.pendingSources(10);
  expect(lease?.source).toEqual(source);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        lease.leaseToken,
      )
    ).ok,
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
  const [lease] = await repo.pendingSources(10);
  if (!lease) throw new Error("missing lease");
  const forged = structuredClone(proposal);
  const forgedItem = forged.items[0];
  const firstEvidence = evidence[0];
  if (!forgedItem || !firstEvidence)
    throw new Error("fixture missing evidence");
  forgedItem.evidence[0] = { ...firstEvidence, quote: "forged" };
  expect(
    await repo.persistProposal(
      systemContext("tidepath"),
      source,
      forged,
      lease.leaseToken,
    ),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  const invalid = structuredClone(proposal);
  const c = invalid.items[1];
  if (c?.kind === "contribution") c.membershipId = "missing";
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        invalid,
        lease.leaseToken,
      )
    ).ok,
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
  const [lease] = await repo.pendingSources(10);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        lease.leaseToken,
      )
    ).ok,
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
  const [lease] = await repo.pendingSources(10);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        lease.leaseToken,
      )
    ).ok,
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
    const [lease] = await repo.pendingSources(1);
    expect(lease?.source).toEqual(source);
    if (!lease) throw new Error("missing lease");
    expect(await repo.pendingSources(1)).toEqual([]);
    await repo.markFailure(source, lease.leaseToken);
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
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        lease.leaseToken,
      )
    ).ok,
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

it("amends a reviewed source revision in place without inflating approved minutes", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("missing first lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "review-1",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  const revised = {
    ...source,
    revision: 2,
    replacesRevision: 1,
    idempotencyKey: "s2",
    text: "Helped for 90 minutes",
    original: { mediaType: "text/plain", payload: "Helped for 90 minutes" },
  };
  const sourceRepo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sourceRepo.accept(mira, revised)).ok).toBe(true);
  const next = structuredClone(proposal);
  next.sourceRevision = 2;
  next.runId = "r2";
  for (const item of next.items)
    for (const ev of item.evidence) ev.sourceRevision = 2;
  const contribution = next.items[1];
  if (contribution?.kind !== "contribution") throw new Error("bad fixture");
  contribution.durationMinutes = 90;
  const [second] = await repo.pendingSources(1);
  if (!second) throw new Error("missing second lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        revised,
        next,
        second.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    await repo.decide(staff, {
      runId: "r2",
      expectedRevision: 1,
      idempotencyKey: "review-2",
      decision: "accept",
      reason: "",
    }),
  ).toEqual({ ok: true, value: { revision: 2 } });
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 90, approvedContributions: 1 },
  });
  const rows = await fixture.db.execute(
    sql`select aggregate_revision,before,after from domain_audit_event where aggregate_type='contribution' order by aggregate_revision`,
  );
  // Audit table names its revision aggregate_revision, so inspect snapshots directly.
  expect(
    rows.rows.map(
      (row) => (row.after as { durationMinutes: number }).durationMinutes,
    ),
  ).toEqual([60, 90]);
});

it("prevents a stale lease from changing a new claim", async () => {
  const repo = createProcessingRepository(fixture.db);
  const [old] = await repo.pendingSources(1);
  if (!old) throw new Error("missing lease");
  await fixture.db.execute(
    sql`update processing_work set lease_until=now()-interval '1 second'`,
  );
  const [current] = await repo.pendingSources(1);
  if (!current) throw new Error("missing new lease");
  expect(current.leaseToken).not.toBe(old.leaseToken);
  await repo.markFailure(source, old.leaseToken);
  expect(
    await repo.persistProposal(
      systemContext("tidepath"),
      source,
      proposal,
      old.leaseToken,
    ),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        current.leaseToken,
      )
    ).ok,
  ).toBe(true);
});
it("rejects duplicate participants and leaves the ledger untouched", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const repeated = structuredClone(proposal);
  const item = repeated.items[1];
  if (item?.kind !== "contribution") throw new Error("bad fixture");
  repeated.items.push({ ...item, key: "duplicate" });
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        repeated,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    await repo.decide(staff, {
      runId: "r1",
      expectedRevision: 1,
      idempotencyKey: "duplicate",
      decision: "accept",
      reason: "",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 0, approvedContributions: 0 },
  });
});

it("applies an explicit same-tenant correction with a revision guard and reason", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "initial",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  const found = await fixture.db.execute(sql`select id from contribution`);
  const id = found.rows[0]?.id as string;
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const revised = {
    ...source,
    revision: 2,
    replacesRevision: 1,
    idempotencyKey: "correction-source",
  };
  const sourceRepo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sourceRepo.accept(mira, revised)).ok).toBe(true);
  const correction: ExtractionProposal = {
    ...proposal,
    runId: "correction-run",
    sourceRevision: 2,
    items: [
      {
        kind: "correction",
        key: "fix",
        targetId: id,
        expectedRevision: 1,
        durationMinutes: 90,
        reason: "Volunteer clarified",
        evidence: evidence.map((entry) => ({ ...entry, sourceRevision: 2 })),
      },
    ],
  };
  const [second] = await repo.pendingSources(1);
  if (!second) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        revised,
        correction,
        second.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "correction-run",
        expectedRevision: 1,
        idempotencyKey: "correction",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 90, approvedContributions: 1 },
  });
  const history = await fixture.db.execute(
    sql`select reason from domain_audit_event where aggregate_type='contribution' and aggregate_revision=2`,
  );
  expect(JSON.parse(history.rows[0]?.reason as string)).toEqual({
    sourceId: "s1",
    sourceRevision: 2,
    staffReason: "",
    proposalReason: "Volunteer clarified",
  });
});
it.each(["independent edit", "changed identity"])(
  "stops reconciliation on %s",
  async (scenario) => {
    const repo = createProcessingRepository(fixture.db);
    const staff = await context(
      fixture.authorization,
      "user-kai",
      "tidepath",
      "review",
    );
    const mira = await context(
      fixture.authorization,
      "user-mira",
      "tidepath",
      "source",
    );
    const [first] = await repo.pendingSources(1);
    if (!first) throw new Error("missing lease");
    expect(
      (
        await repo.persistProposal(
          systemContext("tidepath"),
          source,
          proposal,
          first.leaseToken,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await repo.decide(staff, {
          runId: "r1",
          expectedRevision: 1,
          idempotencyKey: "initial",
          decision: "accept",
          reason: "",
        })
      ).ok,
    ).toBe(true);
    if (scenario === "independent edit") {
      const rows = await fixture.db.execute(sql`select id from contribution`);
      expect(
        (
          await fixture.ledger.transitionContribution(staff, {
            schemaVersion: 1,
            idempotencyKey: "staff-correction",
            contributionId: rows.rows[0]?.id as string,
            expectedRevision: 1,
            action: "correct",
            durationMinutes: 75,
            reason: "Staff confirmed",
          })
        ).ok,
      ).toBe(true);
    }
    const revised = {
      ...source,
      revision: 2,
      replacesRevision: 1,
      idempotencyKey: "s2",
    };
    const sourceRepo = createSourceRepository({
      authorization: fixture.authorization,
      store: createSourceStore(fixture.db),
    });
    expect((await sourceRepo.accept(mira, revised)).ok).toBe(true);
    const next = structuredClone(proposal);
    next.sourceRevision = 2;
    next.runId = "r2";
    for (const item of next.items)
      for (const ev of item.evidence) ev.sourceRevision = 2;
    const contribution = next.items[1];
    if (contribution?.kind !== "contribution") throw new Error("bad fixture");
    contribution.durationMinutes = 90;
    if (scenario === "changed identity")
      contribution.membershipId = "tidepath-sol";
    const [second] = await repo.pendingSources(1);
    if (!second) throw new Error("missing lease");
    expect(
      (
        await repo.persistProposal(
          systemContext("tidepath"),
          revised,
          next,
          second.leaseToken,
        )
      ).ok,
    ).toBe(true);
    expect(
      await repo.decide(staff, {
        runId: "r2",
        expectedRevision: 1,
        idempotencyKey: "conflict",
        decision: "accept",
        reason: "",
      }),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await fixture.ledger.summarize(staff)).toMatchObject({
      ok: true,
      value: {
        approvedMinutes: scenario === "independent edit" ? 75 : 60,
        approvedContributions: 1,
      },
    });
  },
);
it("requires reasoned staff authorization for a correction to an unrelated source", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "initial",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  const rows = await fixture.db.execute(sql`select id from contribution`);
  const targetId = rows.rows[0]?.id as string;
  const unrelated = {
    ...source,
    sourceId: "unrelated",
    externalMessageId: "unrelated",
    idempotencyKey: "unrelated",
  };
  const sourceRepo = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sourceRepo.accept(mira, unrelated)).ok).toBe(true);
  const items: ExtractionProposal["items"] = [
    {
      kind: "correction",
      key: "fix",
      targetId,
      expectedRevision: 1,
      durationMinutes: 90,
      reason: "Model guessed",
      evidence: evidence.map((ev) => ({ ...ev, sourceId: "unrelated" })),
    },
  ];
  const correction: ExtractionProposal = {
    ...proposal,
    sourceId: "unrelated",
    runId: "other-run",
    items,
  };
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        unrelated,
        correction,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    await repo.decide(staff, {
      runId: "other-run",
      expectedRevision: 1,
      idempotencyKey: "denied",
      decision: "accept",
      reason: "",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 60 },
  });
  expect(
    (
      await repo.decide(staff, {
        runId: "other-run",
        expectedRevision: 1,
        idempotencyKey: "confirmed",
        decision: "accept",
        reason: "Confirmed with volunteer",
        replacementItems: items,
      })
    ).ok,
  ).toBe(true);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 90 },
  });
  const history = await fixture.db.execute(
    sql`select reason from domain_audit_event where aggregate_type='contribution' and aggregate_revision=2`,
  );
  expect(JSON.parse(history.rows[0]?.reason as string)).toEqual({
    sourceId: "unrelated",
    sourceRevision: 1,
    staffReason: "Confirmed with volunteer",
    proposalReason: "Model guessed",
  });
});
it.each([
  "same volunteer",
  "shared visit",
  "different duration",
  "stale activity",
])("links duplicate candidates safely: %s", async (scenario) => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const firstProposal = {
    ...proposal,
    items: proposal.items.filter((item) => item.kind !== "need"),
  };
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        firstProposal,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "first",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  const activities = await fixture.db.execute(sql`select id from activity`);
  const activityId = activities.rows[0]?.id as string;
  const secondSource = {
    ...source,
    sourceId: "second",
    externalMessageId: "second",
    idempotencyKey: "second",
  };
  const sources = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sources.accept(mira, secondSource)).ok).toBe(true);
  const second: ExtractionProposal = structuredClone({
    ...firstProposal,
    runId: "r2",
    sourceId: "second",
    unresolved: [{ field: "duplicateCandidate", reason: "possible duplicate" }],
  });
  for (const item of second.items)
    for (const ev of item.evidence) ev.sourceId = "second";
  const contribution = second.items.find(
    (item) => item.kind === "contribution",
  );
  if (contribution?.kind !== "contribution")
    throw new Error("missing contribution");
  if (scenario === "shared visit") contribution.membershipId = "tidepath-sol";
  if (scenario === "different duration") contribution.durationMinutes = 90;
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        secondSource,
        second,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    await repo.decide(staff, {
      runId: "r2",
      expectedRevision: 1,
      idempotencyKey: "unlinked",
      decision: "accept",
      reason: "",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  const result = await repo.decide(staff, {
    runId: "r2",
    expectedRevision: 1,
    idempotencyKey: "linked",
    decision: "accept",
    reason: "Confirmed same visit",
    activityLinks: {
      a: {
        activityId,
        expectedRevision: scenario === "stale activity" ? 2 : 1,
      },
    },
  });
  if (scenario === "different duration" || scenario === "stale activity")
    expect(result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  else expect(result.ok).toBe(true);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: {
      approvedMinutes: scenario === "shared visit" ? 120 : 60,
      approvedContributions: scenario === "shared visit" ? 2 : 1,
    },
  });
  const counts = await fixture.db.execute(
    sql`select count(*)::int as count from activity`,
  );
  expect(counts.rows[0]?.count).toBe(1);
});
it.each([
  "review-all",
  "validated",
  "unknown",
  "urgent",
  "correction",
  "candidate",
  "removed member",
  "other live member",
  "stale policy",
])("applies only eligible validated policy: %s", async (scenario) => {
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
  const repo = createProcessingRepository(fixture.db);
  const settings = createFollowThroughRepository(fixture.db);
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const ready = structuredClone(proposal);
  ready.policyVersion = scenario === "review-all" ? "1" : "policy";
  for (const item of ready.items) {
    if (item.kind === "activity") {
      item.localDate = "2026-11-04";
      item.datePrecision = "day";
    }
    if (item.kind === "need") item.urgency = "routine";
  }
  if (scenario === "unknown") {
    const c = ready.items.find((x) => x.kind === "contribution");
    if (c?.kind === "contribution") c.durationMinutes = null;
  }
  if (scenario === "other live member") {
    const contribution = ready.items.find((x) => x.kind === "contribution");
    if (contribution?.kind !== "contribution") throw new Error("fixture");
    contribution.membershipId = "tidepath-sol";
  }
  if (scenario === "urgent") {
    const n = ready.items.find((x) => x.kind === "need");
    if (n?.kind === "need") n.urgency = "urgent";
  }
  if (scenario === "candidate")
    ready.unresolved.push({
      field: "duplicateCandidate",
      reason: "possible match",
    });
  if (scenario === "correction")
    ready.items = [
      {
        kind: "correction",
        key: "fix",
        targetId: "other",
        expectedRevision: 1,
        durationMinutes: 90,
        reason: "test",
        evidence,
      },
    ];
  if (scenario !== "review-all")
    expect(
      (
        await settings.updateSettings(owner, {
          expectedRevision: 1,
          idempotencyKey: "settings",
          timezone: "UTC",
          automationPolicy: "validated-auto-record",
          policyVersion: "policy",
          routing: {},
          fallbackMembershipId: null,
          ackMinutes: 60,
          retentionDays: 365,
        })
      ).ok,
    ).toBe(true);
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const sources = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sources.accept(mira, source)).ok).toBe(true);
  if (scenario === "stale policy")
    expect(
      (
        await settings.updateSettings(owner, {
          expectedRevision: 2,
          idempotencyKey: "settings-next",
          timezone: "UTC",
          automationPolicy: "review-all",
          policyVersion: "other",
          routing: {},
          fallbackMembershipId: null,
          ackMinutes: 60,
          retentionDays: 365,
        })
      ).ok,
    ).toBe(true);
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        ready,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  if (scenario === "removed member")
    await fixture.db
      .delete(schema.member)
      .where(sql`${schema.member.id}='tidepath-mira'`);
  const result = await repo.applyValidatedPolicy(source);
  expect(result).toEqual({
    ok: true,
    value: { applied: scenario === "validated" || scenario === "stale policy" },
  });
  if (scenario === "other live member") {
    const totals = await fixture.db.execute(
      sql`select count(*)::int as count from contribution where status='approved'`,
    );
    expect(totals.rows[0]?.count).toBe(0);
  }
  if (scenario === "validated" || scenario === "stale policy") {
    expect(await repo.applyValidatedPolicy(source)).toEqual(result);
    const records = await fixture.db.execute(
      sql`select actor,command from review_decision`,
    );
    expect(records.rows[0]?.actor).toEqual({
      kind: "system",
      service: "worker",
    });
    expect(records.rows[0]?.command).toMatchObject({
      reason: "Automatic policy policy",
    });
    const totals = await fixture.db.execute(
      sql`select sum(duration_minutes)::int as total from contribution where status='approved'`,
    );
    expect(totals.rows[0]?.total).toBe(60);
  } else {
    const rows = await fixture.db.execute(
      sql`select status from extraction_run`,
    );
    expect(rows.rows[0]?.status).toBe("review");
  }
});
it("leaves a plausible existing activity in review under validated policy", async () => {
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
  const repo = createProcessingRepository(fixture.db);
  const settings = createFollowThroughRepository(fixture.db);
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  expect(
    (
      await settings.updateSettings(owner, {
        expectedRevision: 1,
        idempotencyKey: "settings",
        timezone: "UTC",
        automationPolicy: "validated-auto-record",
        policyVersion: "1",
        routing: {},
        fallbackMembershipId: null,
        ackMinutes: 60,
        retentionDays: 365,
      })
    ).ok,
  ).toBe(true);
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const sources = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sources.accept(mira, source)).ok).toBe(true);
  const prior = await fixture.ledger.recordActivity(staff, {
    schemaVersion: 1,
    idempotencyKey: "prior",
    kind: "visit",
    localDate: "2026-11-04",
    datePrecision: "day",
    beneficiaryReference: null,
    origin: { kind: "staff", reason: "Existing visit" },
    contributions: [],
  });
  expect(prior.ok).toBe(true);
  const ready = structuredClone(proposal);
  for (const item of ready.items) {
    if (item.kind === "activity") {
      item.localDate = "2026-11-04";
      item.datePrecision = "day";
    }
    if (item.kind === "need") item.urgency = "routine";
  }
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        ready,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(await repo.applyValidatedPolicy(source)).toEqual({
    ok: true,
    value: { applied: false },
  });
});
it("allows audited, idempotent staff retry after exhausted processing", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "retry",
  );
  const volunteer = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "retry",
  );
  for (let i = 0; i < 3; i += 1) {
    const [lease] = await repo.pendingSources(1);
    if (!lease) throw new Error("missing lease");
    await repo.markFailure(source, lease.leaseToken);
    await fixture.db.execute(
      sql`update processing_work set retry_after=now()-interval '1 second'`,
    );
  }
  expect(
    await repo.retrySource(volunteer, {
      sourceId: "s1",
      idempotencyKey: "retry",
    }),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  const command = { sourceId: "s1", idempotencyKey: "retry" };
  expect(await repo.retrySource(staff, command)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await repo.retrySource(staff, command)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    await repo.retrySource(staff, { ...command, sourceId: "other" }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  const rows = await fixture.db.execute(
    sql`select source_id,source_revision,prior_attempts,actor from processing_retry`,
  );
  expect(rows.rows).toMatchObject([
    {
      source_id: "s1",
      source_revision: 1,
      prior_attempts: 3,
      actor: { kind: "user", membershipId: "tidepath-kai" },
    },
  ]);
  await expect(
    fixture.db.execute(sql`update processing_retry set prior_attempts=1`),
  ).rejects.toThrow();
  expect((await repo.pendingSources(1))[0]?.source).toEqual(source);
  await fixture.db
    .delete(schema.member)
    .where(sql`${schema.member.id}='tidepath-kai'`);
  expect(await repo.retrySource(staff, command)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});
it("does not reset an active lease, but permits retry of an exhausted crashed lease", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "retry",
  );
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    await repo.retrySource(staff, { sourceId: "s1", idempotencyKey: "active" }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  await fixture.db.execute(
    sql`update processing_work set attempts=3,failed=false,lease_until=now()-interval '1 second'`,
  );
  expect(await repo.listSourceStatuses(staff)).toEqual({
    ok: true,
    value: [{ sourceId: "s1", revision: 1, status: "failed" }],
  });
  expect(
    await repo.retrySource(staff, { sourceId: "s1", idempotencyKey: "crash" }),
  ).toEqual({ ok: true, value: undefined });
  const [fresh] = await repo.pendingSources(1);
  if (!fresh) throw new Error("missing fresh lease");
  expect(
    await repo.persistProposal(
      systemContext("tidepath"),
      source,
      proposal,
      lease.leaseToken,
    ),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        fresh.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    await repo.retrySource(staff, {
      sourceId: "s1",
      idempotencyKey: "complete",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
});
it.each(["accept", "reject"] as const)(
  "raises one urgent provisional need before review and %ss it",
  async (decision) => {
    const repo = createProcessingRepository(fixture.db);
    const staff = await context(
      fixture.authorization,
      "user-kai",
      "tidepath",
      "review",
    );
    const urgent = structuredClone(proposal);
    const item = urgent.items.find((x) => x.kind === "need");
    if (item?.kind !== "need") throw new Error("fixture");
    item.urgency = "urgent";
    item.provisional = true;
    const [lease] = await repo.pendingSources(1);
    if (!lease) throw new Error("missing lease");
    expect(
      (
        await repo.persistProposal(
          systemContext("tidepath"),
          source,
          urgent,
          lease.leaseToken,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await repo.persistProposal(
          systemContext("tidepath"),
          source,
          urgent,
          lease.leaseToken,
        )
      ).ok,
    ).toBe(true);
    const before = await fixture.db.execute(
      sql`select id,status,provisional,revision from need`,
    );
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0]).toMatchObject({
      status: "new",
      provisional: true,
      revision: 1,
    });
    const changed = await fixture.db.execute(
      sql`select count(*)::int count from outbox_event where type='need.changed'`,
    );
    expect(changed.rows[0]?.count).toBe(1);
    const command = {
      runId: "r1",
      expectedRevision: 1,
      idempotencyKey: "review",
      decision,
      reason: "Reviewed",
    };
    expect((await repo.decide(staff, command)).ok).toBe(true);
    expect((await repo.decide(staff, command)).ok).toBe(true);
    const after = await fixture.db.execute(
      sql`select id,status,provisional,revision from need`,
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({
      id: before.rows[0]?.id,
      status: decision === "accept" ? "new" : "cancelled",
      provisional: true,
      revision: 2,
    });
    const events = await fixture.db.execute(
      sql`select count(*)::int count from outbox_event where type='need.changed'`,
    );
    expect(events.rows[0]?.count).toBe(2);
  },
);
it("rolls back both provisional need and proposal if alert persistence fails", async () => {
  const repo = createProcessingRepository(fixture.db);
  const urgent = structuredClone(proposal);
  const item = urgent.items.find((x) => x.kind === "need");
  if (item?.kind !== "need") throw new Error("fixture");
  item.urgency = "urgent";
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  await fixture.db.execute(
    sql`alter table outbox_event add constraint provisional_test_failure check (type<>'need.changed')`,
  );
  try {
    expect(
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        urgent,
        lease.leaseToken,
      ),
    ).toMatchObject({ ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } });
    const rows = await fixture.db.execute(
      sql`select (select count(*)::int from need) needs,(select count(*)::int from extraction_run) runs`,
    );
    expect(rows.rows[0]).toEqual({ needs: 0, runs: 0 });
  } finally {
    await fixture.db.execute(
      sql`alter table outbox_event drop constraint provisional_test_failure`,
    );
  }
});
it("does not duplicate a previously confirmed urgent need on a later source revision", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const mira = await context(
    fixture.authorization,
    "user-mira",
    "tidepath",
    "source",
  );
  const urgent = structuredClone(proposal);
  const need = urgent.items.find((x) => x.kind === "need");
  if (need?.kind !== "need") throw new Error("fixture");
  need.urgency = "urgent";
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        urgent,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "first",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  const revised = {
    ...source,
    revision: 2,
    replacesRevision: 1,
    idempotencyKey: "revision-2",
  };
  const sources = createSourceRepository({
    authorization: fixture.authorization,
    store: createSourceStore(fixture.db),
  });
  expect((await sources.accept(mira, revised)).ok).toBe(true);
  const next = structuredClone(urgent);
  next.runId = "r2";
  next.sourceRevision = 2;
  for (const item of next.items)
    for (const ev of item.evidence) ev.sourceRevision = 2;
  const [second] = await repo.pendingSources(1);
  if (!second) throw new Error("lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        revised,
        next,
        second.leaseToken,
      )
    ).ok,
  ).toBe(true);
  const rows = await fixture.db.execute(
    sql`select count(*)::int as count from need`,
  );
  expect(rows.rows[0]?.count).toBe(1);
});
it("keeps intake policy snapshot after organization policy changes", async () => {
  const repo = createProcessingRepository(fixture.db);
  const settings = createFollowThroughRepository(fixture.db);
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  expect(
    (
      await settings.updateSettings(owner, {
        expectedRevision: 1,
        idempotencyKey: "new-policy",
        timezone: "UTC",
        automationPolicy: "validated-auto-record",
        policyVersion: "v2",
        routing: {},
        fallbackMembershipId: null,
        ackMinutes: 60,
        retentionDays: 365,
      })
    ).ok,
  ).toBe(true);
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(lease).toMatchObject({
    generation: 1,
    policy: { automationPolicy: "review-all", policyVersion: "1" },
  });
  const ready = structuredClone(proposal);
  for (const item of ready.items)
    if (item.kind === "activity") {
      item.localDate = "2026-11-04";
      item.datePrecision = "day";
    }
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        ready,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(await repo.applyValidatedPolicy(source)).toEqual({
    ok: true,
    value: { applied: false },
  });
});
it("reprocesses the same source as a fresh generation without duplicating approved effects", async () => {
  const repo = createProcessingRepository(fixture.db);
  const settings = createFollowThroughRepository(fixture.db);
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
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.decide(staff, {
        runId: "r1",
        expectedRevision: 1,
        idempotencyKey: "first-review",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await settings.updateSettings(owner, {
        expectedRevision: 1,
        idempotencyKey: "settings",
        timezone: "UTC",
        automationPolicy: "validated-auto-record",
        policyVersion: "v2",
        routing: {},
        fallbackMembershipId: null,
        ackMinutes: 60,
        retentionDays: 365,
      })
    ).ok,
  ).toBe(true);
  const command = {
    sourceId: source.sourceId,
    expectedRevision: 1,
    idempotencyKey: "reprocess",
  };
  expect(await repo.reprocessSource(staff, command)).toEqual({
    ok: true,
    value: { generation: 2 },
  });
  expect(await repo.reprocessSource(staff, command)).toEqual({
    ok: true,
    value: { generation: 2 },
  });
  const [second] = await repo.pendingSources(1);
  if (!second) throw new Error("missing lease");
  expect(second).toMatchObject({
    generation: 2,
    policy: { automationPolicy: "validated-auto-record", policyVersion: "v2" },
  });
  expect(
    await repo.persistProposal(
      systemContext("tidepath"),
      source,
      proposal,
      second.leaseToken,
    ),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  const fresh = structuredClone(proposal);
  fresh.runId = "r2";
  fresh.policyVersion = "v2";
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        fresh,
        second.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(await repo.applyValidatedPolicy(source)).toEqual({
    ok: true,
    value: { applied: false },
  });
  expect(
    (
      await repo.decide(staff, {
        runId: "r2",
        expectedRevision: 1,
        idempotencyKey: "second-review",
        decision: "accept",
        reason: "",
      })
    ).ok,
  ).toBe(true);
  expect(await fixture.ledger.summarize(staff)).toMatchObject({
    ok: true,
    value: { approvedMinutes: 60, approvedContributions: 1 },
  });
  const rows = await fixture.db.execute(
    sql`select run_id,generation,status from extraction_run order by generation`,
  );
  expect(rows.rows).toEqual([
    { run_id: "r1", generation: 1, status: "accepted" },
    { run_id: "r2", generation: 2, status: "accepted" },
  ]);
});
it("prevents an older pending review from being decided after reprocessing starts", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const [first] = await repo.pendingSources(1);
  if (!first) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        proposal,
        first.leaseToken,
      )
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.reprocessSource(staff, {
        sourceId: source.sourceId,
        expectedRevision: 1,
        idempotencyKey: "restart",
      })
    ).ok,
  ).toBe(true);
  expect(
    await repo.decide(staff, {
      runId: "r1",
      expectedRevision: 1,
      idempotencyKey: "stale",
      decision: "accept",
      reason: "",
    }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(await repo.listQueue(staff)).toEqual({ ok: true, value: [] });
});

it("confirms the same urgent need only when a reasoned edit clears provisional", async () => {
  const repo = createProcessingRepository(fixture.db);
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "review",
  );
  const urgent = structuredClone(proposal);
  const item = urgent.items.find((x) => x.kind === "need");
  if (item?.kind !== "need") throw new Error("fixture");
  item.urgency = "urgent";
  item.provisional = true;
  const [lease] = await repo.pendingSources(1);
  if (!lease) throw new Error("missing lease");
  expect(
    (
      await repo.persistProposal(
        systemContext("tidepath"),
        source,
        urgent,
        lease.leaseToken,
      )
    ).ok,
  ).toBe(true);
  const before = await fixture.db.execute(sql`select id from need`);
  const replacement = structuredClone(urgent.items);
  const edited = replacement.find((x) => x.kind === "need");
  if (edited?.kind !== "need") throw new Error("fixture");
  edited.provisional = false;
  const command = {
    runId: "r1",
    expectedRevision: 1,
    idempotencyKey: "confirm",
    decision: "accept" as const,
    reason: "Confirmed with the volunteer",
    replacementItems: replacement,
  };
  expect((await repo.decide(staff, command)).ok).toBe(true);
  expect((await repo.decide(staff, command)).ok).toBe(true);
  const after = await fixture.db.execute(
    sql`select id,provisional,revision from need`,
  );
  expect(after.rows).toEqual([
    { id: before.rows[0]?.id, provisional: false, revision: 2 },
  ]);
});
