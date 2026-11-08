import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  Result,
} from "../../../packages/contracts/src/index.ts";
import { and, eq, schema } from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  auditRows,
  context,
  type DomainFixture,
  openDomainFixture,
  outboxRows,
  seedDomainMembers,
  staffOrigin,
  TIDEPATH,
} from "./domain-support.ts";

const { member } = schema;

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
const owner = (corr: string) =>
  context(fixture.authorization, "user-rae", TIDEPATH, corr);

const createNeed = (idempotencyKey: string, overrides = {}) => ({
  schemaVersion: 1 as const,
  idempotencyKey,
  category: "Transport",
  urgency: "routine" as const,
  summary: "Driver needed for pantry run",
  provisional: false,
  dueAt: null,
  acknowledgeBy: null,
  origin: staffOrigin,
  ...overrides,
});

describe("need lifecycle", () => {
  it("walks create, assign, acknowledge, resolve with events per revision", async () => {
    const kai = await coordinator("corr-lifecycle");
    const rae = await owner("corr-lifecycle-owner");

    const created = await fixture.needs.create(kai, createNeed("idem-n1"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;
    expect(created.value.status).toBe("new");
    expect(created.value.revision).toBe(1);

    const assigned = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n1-assign",
      needId,
      expectedRevision: 1,
      action: "assign",
      ownerMembershipId: "tidepath-kai",
      acknowledgeBy: "2026-11-06T09:00:00.000Z",
    });
    expect(assigned.ok).toBe(true);
    if (!assigned.ok) return;
    expect(assigned.value.status).toBe("assigned");
    expect(assigned.value.ownerMembershipId).toBe("tidepath-kai");
    expect(assigned.value.revision).toBe(2);

    // Only the assignee membership acknowledges.
    const acknowledged = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n1-ack",
      needId,
      expectedRevision: 2,
      action: "acknowledge",
    });
    expect(acknowledged.ok).toBe(true);
    if (!acknowledged.ok) return;
    expect(acknowledged.value.status).toBe("acknowledged");
    expect(acknowledged.value.acknowledgedByMembershipId).toBe("tidepath-kai");
    expect(acknowledged.value.revision).toBe(3);

    const resolved = await fixture.needs.transition(rae, {
      schemaVersion: 1,
      idempotencyKey: "idem-n1-resolve",
      needId,
      expectedRevision: 3,
      action: "resolve",
      resolution: "Neighbor covered the run",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.status).toBe("resolved");
    expect(resolved.value.revision).toBe(4);

    const events = await outboxRows(fixture.db, TIDEPATH, "need.changed");
    expect(
      events.map((event) => [event.aggregateRevision, event.payload]),
    ).toEqual([
      [1, { needId, status: "new", provisional: false }],
      [2, { needId, status: "assigned", provisional: false }],
      [3, { needId, status: "acknowledged", provisional: false }],
      [4, { needId, status: "resolved", provisional: false }],
    ]);

    const audit = await auditRows(fixture.db, TIDEPATH, "need", needId);
    expect(audit.map((row) => row.aggregateRevision)).toEqual([1, 2, 3, 4]);
    expect(audit.map((row) => row.action)).toEqual([
      "create",
      "assign",
      "acknowledge",
      "resolve",
    ]);
  });

  it("denies acknowledgment by an owner-role non-assignee", async () => {
    const kai = await coordinator("corr-ack-other");
    const created = await fixture.needs.create(kai, createNeed("idem-n2"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;
    expect(
      (
        await fixture.needs.transition(kai, {
          schemaVersion: 1,
          idempotencyKey: "idem-n2-assign",
          needId,
          expectedRevision: 1,
          action: "assign",
          ownerMembershipId: "tidepath-kai",
          acknowledgeBy: null,
        })
      ).ok,
    ).toBe(true);

    // Rae is an owner with need:manage, but is not the assignee.
    const denied = await fixture.needs.transition(await owner("corr-ack-rae"), {
      schemaVersion: 1,
      idempotencyKey: "idem-n2-ack",
      needId,
      expectedRevision: 2,
      action: "acknowledge",
    });
    expect(errorOf(denied).code).toBe("FORBIDDEN");
  });

  it.each(["tidepath-mira", "harbor-ive"])(
    "rejects assignment to %s",
    async (membershipId) => {
      const kai = await coordinator("corr-assign-bad");
      const created = await fixture.needs.create(kai, createNeed("idem-n3"));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const result = await fixture.needs.transition(kai, {
        schemaVersion: 1,
        idempotencyKey: `idem-n3-assign-${membershipId}`,
        needId: created.value.needId,
        expectedRevision: 1,
        action: "assign",
        ownerMembershipId: membershipId,
        acknowledgeBy: null,
      });
      const error = errorOf(result);
      expect(error.code).toBe("VALIDATION");
      expect(error.fields?.ownerMembershipId).toBeDefined();
    },
  );

  it("clears acknowledgment when an acknowledged need is reassigned", async () => {
    const kai = await coordinator("corr-reassign");
    const created = await fixture.needs.create(kai, createNeed("idem-n4"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;
    await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n4-assign",
      needId,
      expectedRevision: 1,
      action: "assign",
      ownerMembershipId: "tidepath-kai",
      acknowledgeBy: null,
    });
    await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n4-ack",
      needId,
      expectedRevision: 2,
      action: "acknowledge",
    });

    const reassigned = await fixture.needs.transition(
      await owner("corr-reassign-owner"),
      {
        schemaVersion: 1,
        idempotencyKey: "idem-n4-reassign",
        needId,
        expectedRevision: 3,
        action: "assign",
        ownerMembershipId: "tidepath-rae",
        acknowledgeBy: "2026-11-07T09:00:00.000Z",
      },
    );
    expect(reassigned.ok).toBe(true);
    if (!reassigned.ok) return;
    expect(reassigned.value.status).toBe("assigned");
    expect(reassigned.value.ownerMembershipId).toBe("tidepath-rae");
    expect(reassigned.value.acknowledgedAt).toBeNull();
    expect(reassigned.value.acknowledgedByMembershipId).toBeNull();
    expect(reassigned.value.acknowledgeBy).toBe("2026-11-07T09:00:00.000Z");
  });

  it("rejects transitions not permitted from the current status", async () => {
    const kai = await coordinator("corr-rules");
    const created = await fixture.needs.create(kai, createNeed("idem-n5"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;

    // acknowledge requires assigned.
    const earlyAck = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n5-ack",
      needId,
      expectedRevision: 1,
      action: "acknowledge",
    });
    expect(errorOf(earlyAck).code).toBe("CONFLICT");

    // reopen requires resolved/cancelled.
    const earlyReopen = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n5-reopen",
      needId,
      expectedRevision: 1,
      action: "reopen",
      reason: "Too early",
    });
    expect(errorOf(earlyReopen).code).toBe("CONFLICT");

    // Cancel, then resolve from cancelled is CONFLICT.
    const cancelled = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n5-cancel",
      needId,
      expectedRevision: 1,
      action: "cancel",
      reason: "Need withdrawn",
    });
    expect(cancelled.ok).toBe(true);
    const lateResolve = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n5-resolve",
      needId,
      expectedRevision: 2,
      action: "resolve",
      resolution: "Too late",
    });
    expect(errorOf(lateResolve).code).toBe("CONFLICT");
  });

  it("reopens a resolved need to new with owner fields cleared", async () => {
    const kai = await coordinator("corr-reopen");
    const created = await fixture.needs.create(
      kai,
      createNeed("idem-n6", { dueAt: "2026-11-10T09:00:00.000Z" }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;
    await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n6-assign",
      needId,
      expectedRevision: 1,
      action: "assign",
      ownerMembershipId: "tidepath-kai",
      acknowledgeBy: "2026-11-07T09:00:00.000Z",
    });
    const resolved = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n6-resolve",
      needId,
      expectedRevision: 2,
      action: "resolve",
      resolution: "Covered",
    });
    expect(resolved.ok).toBe(true);

    const reopened = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n6-reopen",
      needId,
      expectedRevision: 3,
      action: "reopen",
      reason: "Coverage fell through",
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.status).toBe("new");
    expect(reopened.value.ownerMembershipId).toBeNull();
    expect(reopened.value.acknowledgeBy).toBeNull();
    expect(reopened.value.dueAt).toBe("2026-11-10T09:00:00.000Z");
    expect(reopened.value.acknowledgedAt).toBeNull();
    expect(reopened.value.resolvedAt).toBeNull();
    expect(reopened.value.resolution).toBeNull();
  });

  it("cancels an urgent provisional need and keeps the audit trail", async () => {
    const kai = await coordinator("corr-provisional");
    const created = await fixture.needs.create(
      kai,
      createNeed("idem-n7", { urgency: "urgent", provisional: true }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.provisional).toBe(true);

    const cancelled = await fixture.needs.transition(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-n7-cancel",
      needId: created.value.needId,
      expectedRevision: 1,
      action: "cancel",
      reason: "Provisional alert withdrawn",
    });
    expect(cancelled.ok).toBe(true);
    if (!cancelled.ok) return;
    expect(cancelled.value.status).toBe("cancelled");

    const audit = await auditRows(
      fixture.db,
      TIDEPATH,
      "need",
      created.value.needId,
    );
    expect(audit).toHaveLength(2);
    expect(audit[1]?.action).toBe("cancel");
    expect(audit[1]?.reason).toBe("Provisional alert withdrawn");
    const events = await outboxRows(fixture.db, TIDEPATH, "need.changed");
    expect(events[1]?.payload).toEqual({
      needId: created.value.needId,
      status: "cancelled",
      provisional: true,
    });
  });

  it("keeps ownerMembershipId when the owner member row is deleted", async () => {
    const kai = await coordinator("corr-owner-delete");
    const created = await fixture.needs.create(kai, createNeed("idem-n8"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;
    expect(
      (
        await fixture.needs.transition(kai, {
          schemaVersion: 1,
          idempotencyKey: "idem-n8-assign",
          needId,
          expectedRevision: 1,
          action: "assign",
          ownerMembershipId: "tidepath-rae",
          acknowledgeBy: null,
        })
      ).ok,
    ).toBe(true);

    await fixture.db
      .delete(member)
      .where(
        and(eq(member.organizationId, TIDEPATH), eq(member.id, "tidepath-rae")),
      );

    const stored = await fixture.needs.get(
      await coordinator("corr-after-delete"),
      needId,
    );
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.ownerMembershipId).toBe("tidepath-rae");
    expect(stored.value.status).toBe("assigned");
  });

  it("serializes concurrent transitions and replays identical commands", async () => {
    const kai = await coordinator("corr-need-race");
    const created = await fixture.needs.create(kai, createNeed("idem-n9"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const needId = created.value.needId;

    const [assigned, cancelled] = await Promise.all([
      fixture.needs.transition(kai, {
        schemaVersion: 1,
        idempotencyKey: "idem-n9-assign",
        needId,
        expectedRevision: 1,
        action: "assign",
        ownerMembershipId: "tidepath-kai",
        acknowledgeBy: null,
      }),
      fixture.needs.transition(kai, {
        schemaVersion: 1,
        idempotencyKey: "idem-n9-cancel",
        needId,
        expectedRevision: 1,
        action: "cancel",
        reason: "Race loser",
      }),
    ]);
    expect([assigned.ok, cancelled.ok].sort()).toEqual([false, true]);

    const audit = await auditRows(fixture.db, TIDEPATH, "need", needId);
    expect(audit.map((row) => row.aggregateRevision)).toEqual([1, 2]);

    // Identical replay of the winning side returns the stored result.
    const winner = assigned.ok ? assigned : cancelled;
    const winnerCommand = assigned.ok
      ? {
          schemaVersion: 1 as const,
          idempotencyKey: "idem-n9-assign",
          needId,
          expectedRevision: 1,
          action: "assign" as const,
          ownerMembershipId: "tidepath-kai",
          acknowledgeBy: null,
        }
      : {
          schemaVersion: 1 as const,
          idempotencyKey: "idem-n9-cancel",
          needId,
          expectedRevision: 1,
          action: "cancel" as const,
          reason: "Race loser",
        };
    const replay = await fixture.needs.transition(kai, winnerCommand);
    expect(replay).toEqual(winner);
    expect((await auditRows(fixture.db, TIDEPATH, "need", needId)).length).toBe(
      2,
    );
  });
});
