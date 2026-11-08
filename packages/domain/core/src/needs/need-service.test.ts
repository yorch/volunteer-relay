import type {
  AuthorizationService,
  NeedRecord,
  NeedTransition,
  TenantContext,
} from "@relay/contracts";
import { describe, expect, it } from "vitest";
import type {
  DomainMutation,
  DomainStore,
  StoredCommand,
} from "../domain-store.ts";
import { createNeedService } from "./need-service.ts";

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
  actor: { kind: "system", service: "scheduler" },
  correlationId: "corr-system",
};

const origin = { kind: "staff", reason: "Intake call" } as const;

function needRecord(overrides: Partial<NeedRecord> = {}): NeedRecord {
  return {
    schemaVersion: 1,
    organizationId,
    needId: "need-1",
    revision: 1,
    category: "Transport",
    urgency: "routine",
    summary: "Driver for pantry run",
    provisional: false,
    status: "new",
    ownerMembershipId: null,
    dueAt: null,
    acknowledgeBy: null,
    acknowledgedAt: null,
    acknowledgedByMembershipId: null,
    resolvedAt: null,
    resolution: null,
    origin,
    createdAt: "2026-11-04T15:00:00.000Z",
    updatedAt: "2026-11-04T15:00:00.000Z",
    ...overrides,
  };
}

function fakeStore() {
  const committed: DomainMutation[] = [];
  const commands = new Map<string, StoredCommand>();
  const roles = new Map<string, string>([
    ["membership-owner", "owner"],
    ["membership-coordinator", "coordinator"],
    ["membership-volunteer", "volunteer"],
    ["staff-2", "coordinator"],
  ]);
  const records: { need: NeedRecord | null; needs: NeedRecord[] } = {
    need: null,
    needs: [],
  };
  const store: DomainStore = {
    async findCommand(_org, key) {
      return commands.get(key) ?? null;
    },
    async findMembershipRole(_org, membershipId) {
      return roles.get(membershipId) ?? null;
    },
    async getActivity() {
      return null;
    },
    async getContribution() {
      return null;
    },
    async listActivityContributions() {
      return [];
    },
    async listContributions() {
      return [];
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
    async getNeed(_org, needId) {
      return records.need?.needId === needId ? records.need : null;
    },
    async listNeeds() {
      return records.needs;
    },
    async commit(mutation) {
      committed.push(mutation);
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
const now = () => new Date("2026-11-05T10:00:00.000Z");

function service(fake: ReturnType<typeof fakeStore>) {
  return createNeedService({
    authorization: authorization(),
    store: fake.store,
    now,
    ids: () => `generated-${++idCounter}`,
  });
}

const createCommand = (overrides = {}) => ({
  schemaVersion: 1 as const,
  idempotencyKey: "idem-need-1",
  category: "Transport",
  urgency: "urgent" as const,
  summary: "Driver for pantry run",
  provisional: true,
  dueAt: null,
  acknowledgeBy: null,
  origin,
  ...overrides,
});

describe("create", () => {
  it("creates a new need at revision 1 with a need.changed event", async () => {
    const fake = fakeStore();
    const result = await service(fake).create(
      context("coordinator"),
      createCommand(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("new");
    expect(result.value.revision).toBe(1);

    const mutation = fake.committed[0];
    expect(mutation).toBeDefined();
    if (!mutation) return;
    expect(mutation.events[0]?.type).toBe("need.changed");
    expect(mutation.events[0]?.payload).toEqual({
      needId: result.value.needId,
      status: "new",
      provisional: true,
    });
    expect(mutation.audit[0]?.action).toBe("create");
  });

  it.each(["owner", "coordinator"] as const)("allows %s", async (role) => {
    const fake = fakeStore();
    expect(
      (await service(fake).create(context(role), createCommand())).ok,
    ).toBe(true);
  });

  it.each(["volunteer", "report-reader"] as const)(
    "denies %s",
    async (role) => {
      const fake = fakeStore();
      const result = await service(fake).create(context(role), createCommand());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("FORBIDDEN");
      expect(fake.committed).toHaveLength(0);
    },
  );

  it("denies system actors", async () => {
    const fake = fakeStore();
    const result = await service(fake).create(systemContext, createCommand());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
  });
});

describe("transition", () => {
  const transition = (overrides: Record<string, unknown> = {}) =>
    ({
      schemaVersion: 1 as const,
      idempotencyKey: "idem-need-t1",
      needId: "need-1",
      expectedRevision: 1,
      ...overrides,
    }) as NeedTransition;

  it("assigns to a live owner or coordinator and clears acknowledgment", async () => {
    const fake = fakeStore();
    fake.records.need = needRecord({
      status: "acknowledged",
      revision: 3,
      ownerMembershipId: "membership-owner",
      acknowledgedAt: "2026-11-04T16:00:00.000Z",
      acknowledgedByMembershipId: "membership-owner",
    });
    const result = await service(fake).transition(
      context("owner"),
      transition({
        action: "assign",
        ownerMembershipId: "staff-2",
        acknowledgeBy: "2026-11-06T09:00:00.000Z",
        expectedRevision: 3,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("assigned");
    expect(result.value.ownerMembershipId).toBe("staff-2");
    expect(result.value.acknowledgedAt).toBeNull();
    expect(result.value.acknowledgedByMembershipId).toBeNull();
    expect(result.value.acknowledgeBy).toBe("2026-11-06T09:00:00.000Z");
    expect(fake.committed[0]?.anchors).toEqual(["staff-2"]);
  });

  it.each(["volunteer", "missing-membership"] as const)(
    "rejects assignment to %s as VALIDATION",
    async (membershipId) => {
      const fake = fakeStore();
      fake.records.need = needRecord();
      const result = await service(fake).transition(
        context("owner"),
        transition({
          action: "assign",
          ownerMembershipId: membershipId,
          acknowledgeBy: null,
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.fields?.ownerMembershipId).toBeDefined();
      expect(fake.committed).toHaveLength(0);
    },
  );

  it("lets only the current owner acknowledge", async () => {
    const fake = fakeStore();
    fake.records.need = needRecord({
      status: "assigned",
      ownerMembershipId: "membership-coordinator",
    });
    const svc = service(fake);

    // A different staff member, even with need:manage, cannot acknowledge.
    const other = await svc.transition(
      context("owner"),
      transition({ action: "acknowledge", idempotencyKey: "idem-ack-other" }),
    );
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.error.code).toBe("FORBIDDEN");

    const owner = await svc.transition(
      context("coordinator"),
      transition({ action: "acknowledge", idempotencyKey: "idem-ack-owner" }),
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(owner.value.status).toBe("acknowledged");
    expect(owner.value.acknowledgedByMembershipId).toBe(
      "membership-coordinator",
    );
    expect(owner.value.acknowledgedAt).toBe("2026-11-05T10:00:00.000Z");
  });

  it("resolves with a resolution and reopens to new with fields cleared", async () => {
    const fake = fakeStore();
    fake.records.need = needRecord({
      status: "resolved",
      revision: 4,
      ownerMembershipId: "membership-owner",
      dueAt: "2026-11-08T09:00:00.000Z",
      acknowledgeBy: "2026-11-06T09:00:00.000Z",
      acknowledgedAt: "2026-11-04T16:00:00.000Z",
      acknowledgedByMembershipId: "membership-owner",
      resolvedAt: "2026-11-04T18:00:00.000Z",
      resolution: "Covered",
    });
    const result = await service(fake).transition(
      context("owner"),
      transition({
        action: "reopen",
        reason: "Driver cancelled",
        expectedRevision: 4,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("new");
    expect(result.value.ownerMembershipId).toBeNull();
    expect(result.value.acknowledgeBy).toBeNull();
    expect(result.value.dueAt).toBe("2026-11-08T09:00:00.000Z");
    expect(result.value.acknowledgedAt).toBeNull();
    expect(result.value.resolvedAt).toBeNull();
    expect(result.value.resolution).toBeNull();
  });

  it.each([
    ["acknowledge", "new"],
    ["acknowledge", "acknowledged"],
    ["resolve", "resolved"],
    ["resolve", "cancelled"],
    ["cancel", "resolved"],
    ["reopen", "new"],
    ["reopen", "assigned"],
    ["assign", "resolved"],
  ] as const)("rejects %s from %s as CONFLICT", async (action, status) => {
    const fake = fakeStore();
    const base: Partial<NeedRecord> = { status };
    if (status === "assigned") base.ownerMembershipId = "membership-owner";
    if (status === "acknowledged") {
      base.ownerMembershipId = "membership-owner";
      base.acknowledgedAt = "2026-11-04T16:00:00.000Z";
      base.acknowledgedByMembershipId = "membership-owner";
    }
    if (status === "resolved") {
      base.resolvedAt = "2026-11-04T18:00:00.000Z";
      base.resolution = "Done";
    }
    fake.records.need = needRecord(base);
    const command =
      action === "assign"
        ? transition({
            action,
            ownerMembershipId: "membership-owner",
            acknowledgeBy: null,
          })
        : action === "acknowledge"
          ? transition({ action })
          : action === "resolve"
            ? transition({ action, resolution: "r" })
            : transition({ action, reason: "r" });
    const result = await service(fake).transition(context("owner"), command);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CONFLICT");
    expect(fake.committed).toHaveLength(0);
  });

  it("emits need.changed on every transition", async () => {
    const fake = fakeStore();
    fake.records.need = needRecord({
      status: "assigned",
      ownerMembershipId: "membership-owner",
    });
    const result = await service(fake).transition(
      context("owner"),
      transition({ action: "resolve", resolution: "Covered" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fake.committed[0]?.events[0]?.payload).toEqual({
      needId: "need-1",
      status: "resolved",
      provisional: false,
    });
    expect(fake.committed[0]?.audit[0]?.reason).toBeNull();
  });

  it("rejects a stale expected revision and replays the stored result", async () => {
    const fake = fakeStore();
    fake.records.need = needRecord();
    const svc = service(fake);
    const owner = context("owner");
    const command = transition({
      action: "resolve",
      resolution: "Covered",
    });
    const first = await svc.transition(owner, command);
    expect(first.ok).toBe(true);

    // The aggregate is now at revision 2.
    fake.records.need = needRecord({
      status: "resolved",
      revision: 2,
      resolvedAt: "2026-11-05T10:00:00.000Z",
      resolution: "Covered",
    });
    const stale = await svc.transition(
      owner,
      transition({
        action: "cancel",
        reason: "No longer needed",
        idempotencyKey: "idem-stale",
        expectedRevision: 1,
      }),
    );
    // Aggregate moved to revision 2; a stale expected revision conflicts.
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.code).toBe("CONFLICT");

    fake.records.need = needRecord({ status: "cancelled", revision: 7 });
    const replay = await svc.transition(owner, command);
    expect(replay).toEqual(first);
    expect(fake.committed).toHaveLength(1);
  });
});

describe("get and list", () => {
  it("requires need:manage for reads", async () => {
    const fake = fakeStore();
    fake.records.need = needRecord();
    fake.records.needs = [needRecord()];
    const svc = service(fake);

    expect((await svc.get(context("owner"), "need-1")).ok).toBe(true);
    expect((await svc.list(context("coordinator"), {})).ok).toBe(true);

    for (const role of ["volunteer", "report-reader"] as const) {
      const denied = await svc.get(context(role), "need-1");
      expect(denied.ok).toBe(false);
      if (denied.ok) continue;
      expect(denied.error.code).toBe("FORBIDDEN");
    }
    const unknown = await svc.get(context("owner"), "missing");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("NOT_FOUND");
  });
});
