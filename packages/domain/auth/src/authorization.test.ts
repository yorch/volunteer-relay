import { describe, expect, it } from "vitest";
import {
  createAuthorizationService,
  type MembershipSnapshot,
  type MembershipSource,
} from "./authorization.ts";

const organizationId = "org-tidepath";
const otherOrganizationId = "org-riverbend";
const userId = "user-ana";
const membershipId = "member-ana";

function snapshot(overrides: Partial<MembershipSnapshot> = {}) {
  return {
    membershipId,
    organizationId,
    userId,
    role: "coordinator",
    ...overrides,
  };
}

function sourceReturning(rows: MembershipSnapshot[]) {
  const calls: Array<{ userId: string; organizationId: string }> = [];
  const source: MembershipSource = {
    async findMembership(key) {
      calls.push(key);
      return (
        rows.find(
          (row) =>
            row.userId === key.userId &&
            row.organizationId === key.organizationId,
        ) ?? null
      );
    },
  };
  return { source, calls, rows };
}

describe("AuthorizationService.resolve", () => {
  it("returns the contract tenant context for live membership", async () => {
    const { source } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });

    const result = await service.resolve(userId, organizationId, "corr-1");
    expect(result).toEqual({
      ok: true,
      value: {
        organizationId,
        actor: {
          kind: "user",
          userId,
          membershipId,
          role: "coordinator",
        },
        correlationId: "corr-1",
      },
    });
  });

  it("conceals membership in another tenant as NOT_FOUND", async () => {
    const { source, calls } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });

    const result = await service.resolve(userId, otherOrganizationId, "corr-2");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toBe("Organization not available");
    expect(result.error.correlationId).toBe("corr-2");
    // The lookup was tenant-scoped: no widened query for this user.
    expect(calls).toEqual([{ userId, organizationId: otherOrganizationId }]);
  });

  it("fails closed on an out-of-contract stored role", async () => {
    const { source } = sourceReturning([snapshot({ role: "admin" })]);
    const service = createAuthorizationService({ memberships: source });

    const result = await service.resolve(userId, organizationId, "corr-3");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
  });

  it("rejects a lookup that returns another tenant's row", async () => {
    // A misbehaving reader answers with a different tenant's membership.
    const service = createAuthorizationService({
      memberships: {
        async findMembership() {
          return snapshot({ organizationId: otherOrganizationId });
        },
      },
    });

    const result = await service.resolve(userId, organizationId, "corr-4");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
  });

  it("reports an unavailable lookup as retryable instead of granting", async () => {
    const service = createAuthorizationService({
      memberships: {
        async findMembership() {
          throw new Error("connection terminated");
        },
      },
    });

    const result = await service.resolve(userId, organizationId, "corr-5");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.error.retryable).toBe(true);
  });

  it("requires identifiers", async () => {
    const { source } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });

    const missingUser = await service.resolve("", organizationId, "corr-6");
    const missingCorrelation = await service.resolve(
      userId,
      organizationId,
      "",
    );
    expect(missingUser.ok).toBe(false);
    if (missingUser.ok) throw new Error("expected failure");
    expect(missingUser.error.code).toBe("UNAUTHENTICATED");
    expect(missingCorrelation.ok).toBe(false);
    if (missingCorrelation.ok) throw new Error("expected failure");
    expect(missingCorrelation.error.code).toBe("VALIDATION");
  });
});

describe("AuthorizationService.require", () => {
  it("allows a granted permission for live membership", async () => {
    const { source } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });
    const resolved = await service.resolve(userId, organizationId, "corr-10");
    if (!resolved.ok) throw new Error("expected context");

    const result = await service.require(resolved.value, "review:write");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  it("denies a permission the live role does not grant", async () => {
    const { source } = sourceReturning([snapshot({ role: "volunteer" })]);
    const service = createAuthorizationService({ memberships: source });
    const resolved = await service.resolve(userId, organizationId, "corr-11");
    if (!resolved.ok) throw new Error("expected context");

    const result = await service.require(resolved.value, "review:write");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
    expect(result.error.correlationId).toBe("corr-11");
  });

  it("denies a context whose membership was revoked after resolution", async () => {
    const { source, rows } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });
    const resolved = await service.resolve(userId, organizationId, "corr-12");
    if (!resolved.ok) throw new Error("expected context");

    rows.length = 0;

    const result = await service.require(resolved.value, "source:submit");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
    expect(result.error.message).toBe("Membership is no longer active");
    expect((await service.resolve(userId, organizationId, "corr-13")).ok).toBe(
      false,
    );
  });

  it("uses the live role, not the role captured in the context", async () => {
    const { source, rows } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });
    const resolved = await service.resolve(userId, organizationId, "corr-14");
    if (!resolved.ok) throw new Error("expected context");

    rows[0] = snapshot({ role: "volunteer" });

    const downgraded = await service.require(resolved.value, "review:write");
    expect(downgraded.ok).toBe(false);
    if (downgraded.ok) throw new Error("expected failure");
    expect(downgraded.error.code).toBe("FORBIDDEN");
    expect((await service.require(resolved.value, "source:submit")).ok).toBe(
      true,
    );
  });

  it("rejects a stale context whose membership was replaced", async () => {
    const { source, rows } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });
    const resolved = await service.resolve(userId, organizationId, "corr-15");
    if (!resolved.ok) throw new Error("expected context");

    rows[0] = snapshot({ membershipId: "member-ana-rejoined" });

    const result = await service.require(resolved.value, "source:submit");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
    expect(result.error.message).toBe(
      "Tenant context is stale; resolve it again",
    );
  });

  it("denies human authority to system actors", async () => {
    const { source } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });

    const result = await service.require(
      {
        organizationId,
        actor: { kind: "system", service: "worker" },
        correlationId: "corr-16",
      },
      "review:write",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
  });

  it("rejects an unknown permission and an unavailable lookup", async () => {
    const { source } = sourceReturning([snapshot()]);
    const service = createAuthorizationService({ memberships: source });
    const resolved = await service.resolve(userId, organizationId, "corr-17");
    if (!resolved.ok) throw new Error("expected context");

    const unknown = await service.require(
      resolved.value,
      "review:approve" as "review:write",
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) throw new Error("expected failure");
    expect(unknown.error.code).toBe("VALIDATION");

    const failing = createAuthorizationService({
      memberships: {
        async findMembership() {
          throw new Error("pool exhausted");
        },
      },
    });
    const unavailable = await failing.require(resolved.value, "source:submit");
    expect(unavailable.ok).toBe(false);
    if (unavailable.ok) throw new Error("expected failure");
    expect(unavailable.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(unavailable.error.retryable).toBe(true);
  });
});
