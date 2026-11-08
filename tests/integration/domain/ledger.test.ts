import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  Result,
} from "../../../packages/contracts/src/index.ts";
import { and, eq, schema, sql } from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { expectDatabaseRejection, resetAuthTables } from "../auth/support.ts";
import {
  auditRows,
  context,
  type DomainFixture,
  onlyContribution,
  openDomainFixture,
  outboxRows,
  seedDomainMembers,
  staffOrigin,
  TIDEPATH,
} from "./domain-support.ts";

const { domainCommand, contribution, member } = schema;

let fixture: DomainFixture;

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
});

function errorOf<T>(result: Result<T>): ApiError["error"] {
  if (result.ok) throw new Error("expected a failure result");
  return result.error;
}

const coordinator = (corr: string) =>
  context(fixture.authorization, "user-kai", TIDEPATH, corr);
const mira = (corr: string) =>
  context(fixture.authorization, "user-mira", TIDEPATH, corr);
const sol = (corr: string) =>
  context(fixture.authorization, "user-sol", TIDEPATH, corr);
const reader = (corr: string) =>
  context(fixture.authorization, "user-ren", TIDEPATH, corr);

const activityCommand = (idempotencyKey: string, overrides = {}) => ({
  schemaVersion: 1 as const,
  idempotencyKey,
  kind: "Kitchen shift",
  localDate: "2026-11-04",
  datePrecision: "day" as const,
  beneficiaryReference: null,
  origin: staffOrigin,
  contributions: [
    { membershipId: "tidepath-mira", durationMinutes: 60 },
    { membershipId: "tidepath-sol", durationMinutes: 60 },
  ],
  ...overrides,
});

const approve = (
  contributionId: string,
  expectedRevision: number,
  idempotencyKey: string,
) => ({
  schemaVersion: 1 as const,
  idempotencyKey,
  contributionId,
  expectedRevision,
  action: "approve" as const,
});

describe("shared visit lifecycle", () => {
  it("approves two volunteers and summarizes 120 approved minutes", async () => {
    const kai = await coordinator("corr-record");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-1"),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    for (const [index, draft] of recorded.value.contributions.entries()) {
      const result = await fixture.ledger.transitionContribution(
        kai,
        approve(draft.contributionId, 1, `idem-approve-${index}`),
      );
      expect(result.ok).toBe(true);
    }

    const summary = await fixture.ledger.summarize(kai);
    expect(summary).toEqual({
      ok: true,
      value: {
        approvedMinutes: 120,
        approvedContributions: 2,
        activitiesWithApprovedContributions: 1,
        pendingContributions: 0,
        pendingUnknownDuration: 0,
        pendingUnresolvedVolunteer: 0,
      },
    });
  });

  it("rejects a second active contribution for the same membership, then allows re-add after supersede", async () => {
    const kai = await coordinator("corr-dup");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-2"),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const activityId = recorded.value.activity.activityId;
    const solContribution = recorded.value.contributions.find(
      (c) => c.membershipId === "tidepath-sol",
    );
    expect(solContribution).toBeDefined();
    if (!solContribution) return;

    const duplicate = await fixture.ledger.addContribution(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-dup-sol",
      activityId,
      membershipId: "tidepath-sol",
      durationMinutes: 30,
      origin: staffOrigin,
    });
    expect(errorOf(duplicate).code).toBe("CONFLICT");

    // Approve Sol, then supersede: re-adding becomes possible again.
    expect(
      (
        await fixture.ledger.transitionContribution(
          kai,
          approve(solContribution.contributionId, 1, "idem-approve-sol"),
        )
      ).ok,
    ).toBe(true);
    const superseded = await fixture.ledger.transitionContribution(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-super-sol",
      contributionId: solContribution.contributionId,
      expectedRevision: 2,
      action: "supersede",
      reason: "Wrong activity",
    });
    expect(superseded.ok).toBe(true);

    const readded = await fixture.ledger.addContribution(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-readd-sol",
      activityId,
      membershipId: "tidepath-sol",
      durationMinutes: 30,
      origin: staffOrigin,
    });
    expect(readded.ok).toBe(true);
    if (!readded.ok) return;
    expect(readded.value.status).toBe("pending");
    expect(readded.value.contributionId).not.toBe(
      solContribution.contributionId,
    );
  });

  it("corrects an approved contribution 60 to 90 with retained history", async () => {
    const kai = await coordinator("corr-correct");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-3", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    expect(
      (
        await fixture.ledger.transitionContribution(
          kai,
          approve(contributionId, 1, "idem-approve-mira"),
        )
      ).ok,
    ).toBe(true);

    const corrected = await fixture.ledger.transitionContribution(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-correct-mira",
      contributionId,
      expectedRevision: 2,
      action: "correct",
      durationMinutes: 90,
      reason: "Timesheet correction",
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.contributionId).toBe(contributionId);
    expect(corrected.value.revision).toBe(3);
    expect(corrected.value.durationMinutes).toBe(90);
    expect(corrected.value.status).toBe("approved");

    const summary = await fixture.ledger.summarize(kai);
    expect(summary.ok && summary.value.approvedMinutes).toBe(90);

    // Audit history preserves every revision with before/after snapshots.
    const audit = await auditRows(
      fixture.db,
      TIDEPATH,
      "contribution",
      contributionId,
    );
    expect(audit.map((row) => row.aggregateRevision)).toEqual([1, 2, 3]);
    const third = audit[2];
    expect(third).toBeDefined();
    if (!third) return;
    expect((third.before as { durationMinutes: number }).durationMinutes).toBe(
      60,
    );
    expect((third.after as { durationMinutes: number }).durationMinutes).toBe(
      90,
    );

    // Outbox holds approved (rev 2) and corrected (rev 3) ledger events.
    const events = await outboxRows(fixture.db, TIDEPATH, "ledger.changed");
    expect(
      events.map((event) => [event.aggregateRevision, event.payload]),
    ).toEqual([
      [2, { contributionId, reason: "approved" }],
      [3, { contributionId, reason: "corrected" }],
    ]);
  });
});

describe("approval invariants", () => {
  it("keeps an unknown-duration contribution pending and out of totals", async () => {
    const kai = await coordinator("corr-unknown");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-4", {
        contributions: [
          { membershipId: "tidepath-mira", durationMinutes: null },
        ],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    const attempted = await fixture.ledger.transitionContribution(
      kai,
      approve(contributionId, 1, "idem-approve-unknown"),
    );
    expect(errorOf(attempted).code).toBe("VALIDATION");

    const summary = await fixture.ledger.summarize(kai);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.approvedMinutes).toBe(0);
    expect(summary.value.pendingUnknownDuration).toBe(1);

    // Correcting to a known duration makes approval possible.
    expect(
      (
        await fixture.ledger.transitionContribution(kai, {
          schemaVersion: 1,
          idempotencyKey: "idem-correct-45",
          contributionId,
          expectedRevision: 1,
          action: "correct",
          durationMinutes: 45,
          reason: "Duration confirmed",
        })
      ).ok,
    ).toBe(true);
    const approved = await fixture.ledger.transitionContribution(
      kai,
      approve(contributionId, 2, "idem-approve-45"),
    );
    expect(approved.ok).toBe(true);
  });

  it("rejects approval of an unresolved volunteer contribution", async () => {
    const kai = await coordinator("corr-null-member");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-5", {
        contributions: [{ membershipId: null, durationMinutes: 30 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const attempted = await fixture.ledger.transitionContribution(
      kai,
      approve(
        onlyContribution(recorded.value).contributionId,
        1,
        "idem-approve-null",
      ),
    );
    const error = errorOf(attempted);
    expect(error.code).toBe("VALIDATION");
    expect(error.fields?.membershipId).toBeDefined();
  });
});

describe("optimistic concurrency and idempotency", () => {
  it("lets exactly one of two concurrent transitions win a revision", async () => {
    const kai = await coordinator("corr-race");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-6", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    const [first, second] = await Promise.all([
      fixture.ledger.transitionContribution(
        kai,
        approve(contributionId, 1, "idem-race-a"),
      ),
      fixture.ledger.transitionContribution(kai, {
        schemaVersion: 1,
        idempotencyKey: "idem-race-b",
        contributionId,
        expectedRevision: 1,
        action: "reject",
        reason: "Losing transition",
      }),
    ]);
    const outcomes = [first.ok, second.ok].sort();
    expect(outcomes).toEqual([false, true]);
    const loser = first.ok ? second : first;
    expect(errorOf(loser).code).toBe("CONFLICT");

    // Exactly one audit row exists for revision 2.
    const audit = await auditRows(
      fixture.db,
      TIDEPATH,
      "contribution",
      contributionId,
    );
    expect(audit.map((row) => row.aggregateRevision)).toEqual([1, 2]);
  });

  it("returns deep-equal results for concurrent identical commands with one effect", async () => {
    const kai = await coordinator("corr-same-key");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-7", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    const command = approve(contributionId, 1, "idem-same-key");
    const [first, second] = await Promise.all([
      fixture.ledger.transitionContribution(kai, command),
      fixture.ledger.transitionContribution(kai, command),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second).toEqual(first);

    const audit = await auditRows(
      fixture.db,
      TIDEPATH,
      "contribution",
      contributionId,
    );
    expect(audit.map((row) => row.aggregateRevision)).toEqual([1, 2]);
    // One effect: a single stored command row for the shared key.
    const commandRows = await fixture.db
      .select()
      .from(domainCommand)
      .where(eq(domainCommand.idempotencyKey, "idem-same-key"));
    expect(commandRows).toHaveLength(1);
  });

  it("rejects the same key used for a different command", async () => {
    const kai = await coordinator("corr-key-change");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-8", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    expect(
      (
        await fixture.ledger.transitionContribution(
          kai,
          approve(contributionId, 1, "idem-reused"),
        )
      ).ok,
    ).toBe(true);

    const different = await fixture.ledger.transitionContribution(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-reused",
      contributionId,
      expectedRevision: 1,
      action: "reject",
      reason: "Different command, same key",
    });
    expect(errorOf(different).code).toBe("CONFLICT");
  });

  it("re-checks live membership before returning a replay", async () => {
    const kai = await coordinator("corr-replay-auth");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-9", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 10 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;

    // The coordinator's member row is deleted; the same replay is denied.
    await fixture.db
      .delete(member)
      .where(
        and(eq(member.organizationId, TIDEPATH), eq(member.id, "tidepath-kai")),
      );
    const replay = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-9", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 10 }],
      }),
    );
    expect(errorOf(replay).code).toBe("FORBIDDEN");
  });
});

describe("atomicity and history immutability", () => {
  it("rolls the whole mutation back when the outbox insert fails", async () => {
    const kai = await coordinator("corr-rollback");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-10", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    await fixture.db.execute(
      sql`create function p1_13_fail_outbox() returns trigger language plpgsql as $$ begin raise exception 'synthetic outbox failure DETAIL-TEXT'; end $$`,
    );
    await fixture.db.execute(
      sql`create trigger fail_outbox_insert before insert on "outbox_event" for each row execute function p1_13_fail_outbox()`,
    );
    try {
      const result = await fixture.ledger.transitionContribution(
        kai,
        approve(contributionId, 1, "idem-rollback"),
      );
      const error = errorOf(result);
      expect(error.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(error.message).not.toContain("DETAIL-TEXT");
      expect(error.message).not.toContain("synthetic");
    } finally {
      await fixture.db.execute(
        sql`drop trigger fail_outbox_insert on "outbox_event"`,
      );
      await fixture.db.execute(sql`drop function p1_13_fail_outbox()`);
    }

    // The contribution is unchanged and no audit or command row was left.
    const stored = await fixture.db
      .select()
      .from(contribution)
      .where(eq(contribution.id, contributionId));
    expect(stored[0]?.status).toBe("pending");
    expect(stored[0]?.revision).toBe(1);
    expect(
      await auditRows(fixture.db, TIDEPATH, "contribution", contributionId),
    ).toHaveLength(1);
    const commandRows = await fixture.db
      .select()
      .from(domainCommand)
      .where(eq(domainCommand.idempotencyKey, "idem-rollback"));
    expect(commandRows).toHaveLength(0);
  });

  it("rejects UPDATEs on the immutable history tables", async () => {
    const kai = await coordinator("corr-immutable");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-11", { contributions: [] }),
    );
    expect(recorded.ok).toBe(true);

    await expectDatabaseRejection(
      () =>
        fixture.db.execute(
          sql`update domain_audit_event set action = 'tampered' where organization_id = ${TIDEPATH}`,
        ),
      "55000",
    );
    await expectDatabaseRejection(
      () =>
        fixture.db.execute(
          sql`update domain_command set command_type = 'tampered' where organization_id = ${TIDEPATH}`,
        ),
      "55000",
    );
  });

  it("approves a pending contribution after the volunteer's member row is deleted", async () => {
    const kai = await coordinator("corr-approve-departed");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-approve-departed", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 30 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;

    await fixture.db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, TIDEPATH),
          eq(member.id, "tidepath-mira"),
        ),
      );

    const approved = await fixture.ledger.transitionContribution(
      kai,
      approve(contributionId, 1, "idem-approve-departed"),
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.membershipId).toBe("tidepath-mira");

    const summary = await fixture.ledger.summarize(kai);
    expect(summary.ok && summary.value.approvedMinutes).toBe(30);
  });

  it("keeps ledger rows and minutes when a membership is deleted", async () => {
    const kai = await coordinator("corr-delete-member");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-12", {
        contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const contributionId = onlyContribution(recorded.value).contributionId;
    expect(
      (
        await fixture.ledger.transitionContribution(
          kai,
          approve(contributionId, 1, "idem-approve-then-delete"),
        )
      ).ok,
    ).toBe(true);

    // Deleting Mira's member row succeeds; her contribution and minutes stay.
    await fixture.db
      .delete(member)
      .where(
        and(
          eq(member.organizationId, TIDEPATH),
          eq(member.id, "tidepath-mira"),
        ),
      );
    const stored = await fixture.db
      .select()
      .from(contribution)
      .where(eq(contribution.id, contributionId));
    expect(stored[0]?.membershipId).toBe("tidepath-mira");
    expect(stored[0]?.status).toBe("approved");

    const summary = await fixture.ledger.summarize(kai);
    expect(summary.ok && summary.value.approvedMinutes).toBe(60);
  });
});

describe("reviseActivity", () => {
  it("revises an unknown date to a day and rejects stale revisions", async () => {
    const kai = await coordinator("corr-revise");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-13", {
        localDate: null,
        datePrecision: "unknown",
        contributions: [],
      }),
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const activityId = recorded.value.activity.activityId;

    const revised = await fixture.ledger.reviseActivity(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-revise-1",
      activityId,
      expectedRevision: 1,
      kind: "Kitchen shift",
      localDate: "2026-11-04",
      datePrecision: "day",
      beneficiaryReference: null,
      reason: "Date confirmed",
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.revision).toBe(2);
    expect(revised.value.localDate).toBe("2026-11-04");

    const stale = await fixture.ledger.reviseActivity(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-revise-2",
      activityId,
      expectedRevision: 1,
      kind: "Kitchen shift",
      localDate: "2026-11-05",
      datePrecision: "day",
      beneficiaryReference: null,
      reason: "Stale write",
    });
    expect(errorOf(stale).code).toBe("CONFLICT");
  });
});

describe("list access", () => {
  it("scopes volunteer lists to their own contributions", async () => {
    const kai = await coordinator("corr-list-scope");
    const recorded = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-visit-14"),
    );
    expect(recorded.ok).toBe(true);

    const miraList = await fixture.ledger.listContributions(
      await mira("corr-mira-list"),
      {},
    );
    expect(miraList.ok).toBe(true);
    if (!miraList.ok) return;
    expect(
      miraList.value.every((c) => c.membershipId === "tidepath-mira"),
    ).toBe(true);
    expect(miraList.value).toHaveLength(1);

    const readerResult = await fixture.ledger.listContributions(
      await reader("corr-reader-list"),
      {},
    );
    expect(errorOf(readerResult).code).toBe("FORBIDDEN");

    const readerSummary = await fixture.ledger.summarize(
      await reader("corr-reader-summary"),
    );
    expect(readerSummary.ok).toBe(true);

    const volunteerSummary = await fixture.ledger.summarize(
      await sol("corr-sol-summary"),
    );
    expect(errorOf(volunteerSummary).code).toBe("FORBIDDEN");
  });
});
