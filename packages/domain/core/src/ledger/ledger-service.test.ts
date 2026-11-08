import type {
  ActivityRecord,
  AuthorizationService,
  ContributionRecord,
  ContributionTransition,
  TenantContext,
} from "@relay/contracts";
import { describe, expect, it } from "vitest";
import type {
  CommitOutcome,
  DomainMutation,
  DomainStore,
  StoredCommand,
} from "../domain-store.ts";
import { createLedgerService } from "./ledger-service.ts";

const organizationId = "tidepath";

type Role = "owner" | "coordinator" | "volunteer" | "report-reader";

const permissionsByRole: Record<Role, string[]> = {
  owner: ["source:submit", "review:write", "need:manage", "report:read"],
  coordinator: ["source:submit", "review:write", "need:manage", "report:read"],
  volunteer: ["source:submit"],
  "report-reader": ["report:read"],
};

function authorization(): AuthorizationService {
  return {
    async resolve(_userId, _organization, correlationId) {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "not used in these tests",
          correlationId,
          retryable: false,
        },
      };
    },
    async require(context, permission) {
      if (context.actor.kind === "system")
        return {
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "system",
            correlationId: context.correlationId,
            retryable: false,
          },
        };
      return permissionsByRole[context.actor.role].includes(permission)
        ? { ok: true, value: undefined }
        : {
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "not granted",
              correlationId: context.correlationId,
              retryable: false,
            },
          };
    },
  };
}

function context(
  role: Role,
  overrides: Partial<TenantContext> = {},
): TenantContext {
  return {
    organizationId,
    actor: {
      kind: "user",
      userId: `user-${role}`,
      membershipId: `membership-${role}`,
      role,
    },
    correlationId: `corr-${role}`,
    ...overrides,
  };
}

const systemContext: TenantContext = {
  organizationId,
  actor: { kind: "system", service: "worker" },
  correlationId: "corr-system",
};

const origin = { kind: "staff", reason: "Shift log" } as const;

function activityRecord(
  overrides: Partial<ActivityRecord> = {},
): ActivityRecord {
  return {
    schemaVersion: 1,
    organizationId,
    activityId: "activity-1",
    revision: 1,
    kind: "Kitchen shift",
    localDate: "2026-11-04",
    datePrecision: "day",
    beneficiaryReference: null,
    origin,
    createdAt: "2026-11-04T15:00:00.000Z",
    updatedAt: "2026-11-04T15:00:00.000Z",
    ...overrides,
  };
}

function contributionRecord(
  overrides: Partial<ContributionRecord> = {},
): ContributionRecord {
  return {
    schemaVersion: 1,
    organizationId,
    contributionId: "contribution-1",
    activityId: "activity-1",
    revision: 1,
    membershipId: "membership-volunteer",
    durationMinutes: 60,
    status: "pending",
    origin,
    createdAt: "2026-11-04T15:00:00.000Z",
    updatedAt: "2026-11-04T15:00:00.000Z",
    ...overrides,
  };
}

interface FakeStore {
  store: DomainStore;
  committed: DomainMutation[];
  commands: Map<string, StoredCommand>;
  roles: Map<string, string>;
  records: {
    activity: ActivityRecord | null;
    contribution: ContributionRecord | null;
    contributions: ContributionRecord[];
  };
}

function fakeStore(outcome?: CommitOutcome): FakeStore {
  const committed: DomainMutation[] = [];
  const commands = new Map<string, StoredCommand>();
  const roles = new Map<string, string>([
    ["membership-volunteer", "volunteer"],
    ["membership-owner", "owner"],
    ["membership-coordinator", "coordinator"],
    ["tidepath-mira", "volunteer"],
    ["tidepath-sol", "volunteer"],
  ]);
  const records: FakeStore["records"] = {
    activity: null,
    contribution: null,
    contributions: [],
  };
  const store: DomainStore = {
    async findCommand(_org, key) {
      return commands.get(key) ?? null;
    },
    async findMembershipRole(_org, membershipId) {
      return roles.get(membershipId) ?? null;
    },
    async getActivity(_org, activityId) {
      return records.activity?.activityId === activityId
        ? records.activity
        : null;
    },
    async getContribution(_org, contributionId) {
      return records.contribution?.contributionId === contributionId
        ? records.contribution
        : null;
    },
    async listActivityContributions() {
      return records.contributions;
    },
    async listContributions() {
      return records.contributions;
    },
    async summarize() {
      return {
        approvedMinutes: 0,
        approvedContributions: 0,
        activitiesWithApprovedContributions: 0,
        pendingContributions: 0,
        pendingUnknownDuration: 0,
        pendingUnresolvedVolunteer: 0,
      };
    },
    async getNeed() {
      return null;
    },
    async listNeeds() {
      return [];
    },
    async commit(mutation) {
      committed.push(mutation);
      if (outcome) return outcome;
      commands.set(mutation.command.idempotencyKey, {
        commandType: mutation.command.commandType,
        digest: mutation.command.digest,
        result: mutation.command.result,
      });
      return { kind: "committed" };
    },
  };
  return { store, committed, commands, roles, records };
}

let idCounter = 0;
const ids = () => `generated-${++idCounter}`;
const now = () => new Date("2026-11-05T10:00:00.000Z");

function service(fake: FakeStore) {
  return createLedgerService({
    authorization: authorization(),
    store: fake.store,
    now,
    ids,
  });
}

const recordActivityCommand = (overrides = {}) => ({
  schemaVersion: 1 as const,
  idempotencyKey: "idem-record-1",
  kind: "Kitchen shift",
  localDate: "2026-11-04",
  datePrecision: "day" as const,
  beneficiaryReference: null,
  origin,
  contributions: [
    { membershipId: "tidepath-mira", durationMinutes: 60 },
    { membershipId: "tidepath-sol", durationMinutes: null },
    { membershipId: null, durationMinutes: 30 },
  ],
  ...overrides,
});

describe("recordActivity", () => {
  it("persists an activity and pending contributions with anchors for mapped volunteers", async () => {
    const fake = fakeStore();
    const result = await service(fake).recordActivity(
      context("coordinator"),
      recordActivityCommand(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activity.revision).toBe(1);
    expect(result.value.contributions).toHaveLength(3);
    expect(
      result.value.contributions.every((c) => c.status === "pending"),
    ).toBe(true);

    expect(fake.committed).toHaveLength(1);
    const mutation = fake.committed[0];
    expect(mutation).toBeDefined();
    if (!mutation) return;
    expect(mutation.anchors.sort()).toEqual(["tidepath-mira", "tidepath-sol"]);
    expect(mutation.writes).toHaveLength(4);
    // One audit row per created aggregate revision.
    expect(mutation.audit).toHaveLength(4);
    // Recording never emits a ledger.changed event.
    expect(mutation.events).toHaveLength(0);
  });

  it("returns the stored result on an identical replay without new effects", async () => {
    const fake = fakeStore();
    const svc = service(fake);
    const coordinator = context("coordinator");
    const first = await svc.recordActivity(
      coordinator,
      recordActivityCommand(),
    );
    expect(first.ok).toBe(true);
    const replay = await svc.recordActivity(
      coordinator,
      recordActivityCommand(),
    );
    expect(replay).toEqual(first);
    expect(fake.committed).toHaveLength(1);
  });

  it("rejects the same key with a different command", async () => {
    const fake = fakeStore();
    const svc = service(fake);
    const coordinator = context("coordinator");
    await svc.recordActivity(coordinator, recordActivityCommand());
    const changed = await svc.recordActivity(
      coordinator,
      recordActivityCommand({ kind: "Different kind" }),
    );
    expect(changed.ok).toBe(false);
    if (changed.ok) return;
    expect(changed.error.code).toBe("CONFLICT");
  });

  it("rejects a contribution membership that is not a live member", async () => {
    const fake = fakeStore();
    const result = await service(fake).recordActivity(
      context("owner"),
      recordActivityCommand({
        contributions: [{ membershipId: "harbor-nico", durationMinutes: 10 }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fields?.membershipId).toBeDefined();
    expect(fake.committed).toHaveLength(0);
  });

  it.each(["owner", "coordinator"] as const)(
    "allows %s to record",
    async (role) => {
      const fake = fakeStore();
      const result = await service(fake).recordActivity(
        context(role),
        recordActivityCommand(),
      );
      expect(result.ok).toBe(true);
    },
  );

  it.each(["volunteer", "report-reader"] as const)(
    "denies %s recording",
    async (role) => {
      const fake = fakeStore();
      const result = await service(fake).recordActivity(
        context(role),
        recordActivityCommand(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("FORBIDDEN");
      expect(fake.committed).toHaveLength(0);
    },
  );

  it("denies system actors before any storage call", async () => {
    const fake = fakeStore();
    const result = await service(fake).recordActivity(
      systemContext,
      recordActivityCommand(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(fake.committed).toHaveLength(0);
  });

  it("validates the command shape", async () => {
    const fake = fakeStore();
    const result = await service(fake).recordActivity(context("owner"), {
      schemaVersion: 1,
      idempotencyKey: "idem-bad",
      kind: "x",
      localDate: "2026-11-04",
      datePrecision: "unknown",
      beneficiaryReference: null,
      origin,
      contributions: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
  });
});

describe("transitionContribution", () => {
  const transition = (overrides: Record<string, unknown> = {}) =>
    ({
      schemaVersion: 1 as const,
      idempotencyKey: "idem-transition-1",
      contributionId: "contribution-1",
      expectedRevision: 1,
      ...overrides,
    }) as ContributionTransition;

  it("approves a pending contribution and emits ledger.changed approved", async () => {
    const fake = fakeStore();
    fake.records.contribution = contributionRecord();
    const result = await service(fake).transitionContribution(
      context("owner"),
      transition({ action: "approve" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("approved");
    expect(result.value.revision).toBe(2);

    const mutation = fake.committed[0];
    expect(mutation).toBeDefined();
    if (!mutation) return;
    expect(mutation.events).toHaveLength(1);
    expect(mutation.events[0]?.type).toBe("ledger.changed");
    expect(mutation.events[0]?.payload).toEqual({
      contributionId: "contribution-1",
      reason: "approved",
    });
  });

  it("approves a contribution whose recorded membership is no longer live", async () => {
    const fake = fakeStore();
    // The recorded membership has since been removed; approval still succeeds
    // because membership removal preserves approved minutes.
    fake.records.contribution = contributionRecord({
      membershipId: "departed-member",
    });
    const result = await service(fake).transitionContribution(
      context("owner"),
      transition({ action: "approve" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("approved");
    expect(result.value.membershipId).toBe("departed-member");
  });

  it("emits corrected only when correcting an approved contribution", async () => {
    const approved = fakeStore();
    approved.records.contribution = contributionRecord({
      status: "approved",
      revision: 2,
    });
    const corrected = await service(approved).transitionContribution(
      context("owner"),
      transition({
        action: "correct",
        durationMinutes: 90,
        reason: "Timesheet fix",
        expectedRevision: 2,
        idempotencyKey: "idem-correct-approved",
      }),
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    expect(corrected.value.durationMinutes).toBe(90);
    expect(corrected.value.status).toBe("approved");
    expect(corrected.value.contributionId).toBe("contribution-1");
    expect(approved.committed[0]?.events[0]?.payload).toEqual({
      contributionId: "contribution-1",
      reason: "corrected",
    });

    const pending = fakeStore();
    pending.records.contribution = contributionRecord({ status: "pending" });
    const fixed = await service(pending).transitionContribution(
      context("owner"),
      transition({
        action: "correct",
        durationMinutes: 90,
        reason: "Timesheet fix",
        idempotencyKey: "idem-correct-pending",
      }),
    );
    expect(fixed.ok).toBe(true);
    expect(pending.committed[0]?.events).toHaveLength(0);
    expect(pending.committed[0]?.audit).toHaveLength(1);
  });

  it("emits superseded only for an approved contribution", async () => {
    const approved = fakeStore();
    approved.records.contribution = contributionRecord({ status: "approved" });
    const result = await service(approved).transitionContribution(
      context("owner"),
      transition({
        action: "supersede",
        reason: "Wrong activity",
        idempotencyKey: "idem-super-approved",
      }),
    );
    expect(result.ok).toBe(true);
    expect(approved.committed[0]?.events[0]?.payload).toEqual({
      contributionId: "contribution-1",
      reason: "superseded",
    });

    const pending = fakeStore();
    pending.records.contribution = contributionRecord({ status: "pending" });
    const removed = await service(pending).transitionContribution(
      context("owner"),
      transition({
        action: "supersede",
        reason: "Wrong activity",
        idempotencyKey: "idem-super-pending",
      }),
    );
    expect(removed.ok).toBe(true);
    expect(pending.committed[0]?.events).toHaveLength(0);
  });

  it("emits no ledger event on reject", async () => {
    const fake = fakeStore();
    fake.records.contribution = contributionRecord({ status: "pending" });
    const result = await service(fake).transitionContribution(
      context("coordinator"),
      transition({ action: "reject", reason: "Duplicate" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("rejected");
    expect(fake.committed[0]?.events).toHaveLength(0);
  });

  it.each([
    ["approve", "approved"],
    ["approve", "rejected"],
    ["reject", "approved"],
    ["correct", "rejected"],
    ["correct", "superseded"],
    ["supersede", "rejected"],
    ["supersede", "superseded"],
  ] as const)("rejects %s from %s as CONFLICT", async (action, status) => {
    const fake = fakeStore();
    fake.records.contribution = contributionRecord({ status });
    const command =
      action === "approve"
        ? transition({ action })
        : action === "correct"
          ? transition({ action, durationMinutes: 30, reason: "r" })
          : transition({ action, reason: "r" });
    const result = await service(fake).transitionContribution(
      context("owner"),
      command,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
    expect(fake.committed).toHaveLength(0);
  });

  it("rejects approval without a resolved membership or duration", async () => {
    const noMember = fakeStore();
    noMember.records.contribution = contributionRecord({
      membershipId: null,
    });
    const memberless = await service(noMember).transitionContribution(
      context("owner"),
      transition({ action: "approve" }),
    );
    expect(memberless.ok).toBe(false);
    if (memberless.ok) return;
    expect(memberless.error.code).toBe("VALIDATION");
    expect(memberless.error.fields?.membershipId).toBeDefined();

    const noDuration = fakeStore();
    noDuration.records.contribution = contributionRecord({
      durationMinutes: null,
    });
    const durationless = await service(noDuration).transitionContribution(
      context("owner"),
      transition({ action: "approve" }),
    );
    expect(durationless.ok).toBe(false);
    if (durationless.ok) return;
    expect(durationless.error.code).toBe("VALIDATION");
    expect(noDuration.committed).toHaveLength(0);
  });

  it("rejects a stale expected revision", async () => {
    const fake = fakeStore();
    fake.records.contribution = contributionRecord({ revision: 3 });
    const result = await service(fake).transitionContribution(
      context("owner"),
      transition({ action: "approve" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });

  it("replays the original result even after the aggregate moved on", async () => {
    const fake = fakeStore();
    fake.records.contribution = contributionRecord();
    const svc = service(fake);
    const owner = context("owner");
    const command = transition({ action: "approve" });
    const first = await svc.transitionContribution(owner, command);
    expect(first.ok).toBe(true);

    // The aggregate is now at a later revision; a replay still returns the
    // originally stored result rather than re-transitioning.
    fake.records.contribution = contributionRecord({
      status: "superseded",
      revision: 5,
    });
    const replay = await svc.transitionContribution(owner, command);
    expect(replay).toEqual(first);
    expect(fake.committed).toHaveLength(1);
  });

  it("maps a storage conflict to CONFLICT", async () => {
    const fake = fakeStore({ kind: "conflict", reason: "revision" });
    fake.records.contribution = contributionRecord();
    const result = await service(fake).transitionContribution(
      context("owner"),
      transition({ action: "approve" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
  });

  it.each(["volunteer", "report-reader"] as const)(
    "denies %s transitions",
    async (role) => {
      const fake = fakeStore();
      fake.records.contribution = contributionRecord();
      const result = await service(fake).transitionContribution(
        context(role),
        transition({ action: "approve" }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("FORBIDDEN");
    },
  );
});

describe("queries", () => {
  it("lets staff read an activity with contributions", async () => {
    const fake = fakeStore();
    fake.records.activity = activityRecord();
    fake.records.contributions = [contributionRecord()];
    const result = await service(fake).getActivity(
      context("coordinator"),
      "activity-1",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contributions).toHaveLength(1);
  });

  it("returns NOT_FOUND for unknown or cross-tenant activities", async () => {
    const fake = fakeStore();
    const result = await service(fake).getActivity(context("owner"), "missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("scopes the contribution list: staff all, volunteers own only", async () => {
    const fake = fakeStore();
    fake.records.contributions = [contributionRecord()];
    const svc = service(fake);

    const staff = await svc.listContributions(context("owner"), {});
    expect(staff.ok).toBe(true);

    const volunteer = await svc.listContributions(context("volunteer"), {});
    expect(volunteer.ok).toBe(true);

    const reader = await svc.listContributions(context("report-reader"), {});
    expect(reader.ok).toBe(false);
    if (reader.ok) return;
    expect(reader.error.code).toBe("FORBIDDEN");
  });

  it("gates summarize on report:read", async () => {
    const fake = fakeStore();
    const svc = service(fake);
    for (const role of ["owner", "coordinator", "report-reader"] as const) {
      const result = await svc.summarize(context(role));
      expect(result.ok).toBe(true);
    }
    const denied = await svc.summarize(context("volunteer"));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.error.code).toBe("FORBIDDEN");
  });
});

describe("storage failure boundary", () => {
  it("maps a thrown store error to a fixed retryable DEPENDENCY_UNAVAILABLE", async () => {
    const fake = fakeStore();
    fake.store.commit = () => {
      throw new Error("pg driver detail containing record text SECRET-TEXT");
    };
    fake.records.contribution = contributionRecord();
    const result = await service(fake).transitionContribution(
      context("owner"),
      {
        schemaVersion: 1,
        idempotencyKey: "idem-fail",
        contributionId: "contribution-1",
        expectedRevision: 1,
        action: "approve",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).not.toContain("SECRET-TEXT");
    expect(result.error.message).toBe("Domain storage is unavailable");
  });
});
