import type {
  ApiError,
  AuthorizationService,
  Result,
  TenantContext,
} from "@relay/contracts";
import {
  isContractRole,
  isPermission,
  type Permission,
  roleGrants,
} from "./permissions.ts";

export interface MembershipSnapshot {
  membershipId: string;
  organizationId: string;
  userId: string;
  role: string;
}

export interface MembershipSource {
  findMembership(key: {
    userId: string;
    organizationId: string;
  }): Promise<MembershipSnapshot | null>;
}

export interface AuthorizationDependencies {
  memberships: MembershipSource;
}

type Failure = Extract<Result<never>, { ok: false }>;
type LoadedMembership =
  | { ok: true; membership: MembershipSnapshot | null }
  | { ok: false };

function failure(
  code: ApiError["error"]["code"],
  message: string,
  correlationId: string,
  retryable = false,
): Failure {
  return { ok: false, error: { code, message, correlationId, retryable } };
}

/**
 * Resolves tenant context from live membership and re-checks it on every
 * authorization decision. A parsed context never proves authority: the role
 * used for a decision is the stored one at decision time, and a context whose
 * membership was removed or replaced is rejected.
 */
export function createAuthorizationService({
  memberships,
}: AuthorizationDependencies): AuthorizationService {
  // A lookup failure must never read as an authorization grant.
  async function loadMembership(
    userId: string,
    organizationId: string,
  ): Promise<LoadedMembership> {
    try {
      const membership = await memberships.findMembership({
        userId,
        organizationId,
      });
      return { ok: true, membership };
    } catch {
      return { ok: false };
    }
  }

  return {
    async resolve(userId, organizationId, correlationId) {
      if (!userId || !organizationId)
        return failure(
          "UNAUTHENTICATED",
          "User and organization are required",
          correlationId || "-",
        );
      if (!correlationId)
        return failure("VALIDATION", "correlationId is required", "-");

      const loaded = await loadMembership(userId, organizationId);
      if (!loaded.ok)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Membership lookup is unavailable",
          correlationId,
          true,
        );

      const { membership } = loaded;
      // Absent membership is NOT_FOUND, never a hint that another tenant holds it.
      if (!membership)
        return failure(
          "NOT_FOUND",
          "Organization not available",
          correlationId,
        );
      if (
        membership.userId !== userId ||
        membership.organizationId !== organizationId
      )
        return failure(
          "FORBIDDEN",
          "Membership does not match the requested tenant",
          correlationId,
        );
      if (!isContractRole(membership.role))
        return failure("FORBIDDEN", "Role is not permitted", correlationId);

      const context: TenantContext = {
        organizationId,
        actor: {
          kind: "user",
          userId,
          membershipId: membership.membershipId,
          role: membership.role,
        },
        correlationId,
      };
      return { ok: true, value: context };
    },

    async require(context, permission) {
      const correlationId = context.correlationId || "-";
      if (!isPermission(permission))
        return failure("VALIDATION", "Unknown permission", correlationId);

      if (context.actor.kind === "system")
        // Internal actors have no human authority; a service that needs a
        // person's authority must resolve that person's live membership instead.
        return failure(
          "FORBIDDEN",
          "System actor does not carry human authority",
          correlationId,
        );

      const { userId, membershipId } = context.actor;
      const loaded = await loadMembership(userId, context.organizationId);
      if (!loaded.ok)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Membership lookup is unavailable",
          correlationId,
          true,
        );

      const { membership } = loaded;
      if (!membership)
        return failure(
          "FORBIDDEN",
          "Membership is no longer active",
          correlationId,
        );
      if (
        membership.membershipId !== membershipId ||
        membership.userId !== userId ||
        membership.organizationId !== context.organizationId
      )
        return failure(
          "FORBIDDEN",
          "Tenant context is stale; resolve it again",
          correlationId,
        );
      if (!roleGrants(membership.role, permission as Permission))
        return failure(
          "FORBIDDEN",
          "Role does not grant this permission",
          correlationId,
        );

      return { ok: true, value: undefined };
    },
  };
}
