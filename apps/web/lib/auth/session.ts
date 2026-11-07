import type {
  ApiError,
  AuthorizationService,
  Result,
  roleSchema,
  TenantContext,
} from "@relay/contracts";
import { type Database, type MembershipReader, sql } from "@relay/db";
import { isContractRole } from "@relay/domain/auth";
import type { Auth } from "./auth.ts";

type Failure = Extract<Result<never>, { ok: false }>;

function failure(
  code: ApiError["error"]["code"],
  message: string,
  correlationId: string,
  retryable = false,
): Failure {
  return { ok: false, error: { code, message, correlationId, retryable } };
}

export interface SessionResolverDependencies {
  auth: Auth;
  authorization: AuthorizationService;
  memberships: MembershipReader;
  // Needed to invalidate sessions after a password reset and to report
  // transport failures without exposing payloads.
  db: Database;
  mailFailures?: Array<{ kind: "reset" | "invitation" }>;
  // Application origin used to constrain password-reset redirect targets.
  appUrl: string;
  // Whether a mail transport is configured; without one, reset requests are
  // refused with a bounded error instead of silently succeeding.
  mailConfigured: boolean;
}

export interface AvailableOrganization {
  organizationId: string;
  membershipId: string;
  name: string;
  slug: string;
  role: (typeof roleSchema.options)[number];
}

/**
 * Server-only composition of a VERIFIED Better Auth session with live
 * membership. The caller's user id always comes from the verified session;
 * `activeOrganizationId` and any parsed context are never treated as authority.
 */
export function createSessionResolver({
  auth,
  authorization,
  memberships,
  db,
  mailFailures = [],
  appUrl,
  mailConfigured,
}: SessionResolverDependencies) {
  async function verifiedUserId(
    headers: Headers,
    correlationId: string,
  ): Promise<Result<string>> {
    let session: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      session = await auth.api.getSession({ headers });
    } catch {
      return failure(
        "DEPENDENCY_UNAVAILABLE",
        "Session service is unavailable",
        correlationId,
        true,
      );
    }
    // Absent, expired or malformed cookies all read as no session.
    if (!session?.user?.id)
      return failure("UNAUTHENTICATED", "Sign-in is required", correlationId);
    return { ok: true, value: session.user.id };
  }

  function allowedRedirect(redirectTo: string | undefined): string | undefined {
    if (!redirectTo) return undefined;
    try {
      const target = new URL(redirectTo);
      const allowed = new URL(appUrl);
      return target.origin === allowed.origin ? target.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    async resolveVerifiedContext(input: {
      headers: Headers;
      organizationId: string | null | undefined;
      correlationId: string;
    }): Promise<Result<TenantContext>> {
      const verified = await verifiedUserId(input.headers, input.correlationId);
      if (!verified.ok) return verified;
      if (!input.organizationId)
        return failure(
          "VALIDATION",
          "An organization must be selected",
          input.correlationId,
        );
      // Live membership decides; a session active-organization value never does.
      return authorization.resolve(
        verified.value,
        input.organizationId,
        input.correlationId,
      );
    },

    async listAvailableOrganizations(input: {
      headers: Headers;
      correlationId: string;
    }): Promise<Result<AvailableOrganization[]>> {
      const verified = await verifiedUserId(input.headers, input.correlationId);
      if (!verified.ok) return verified;

      let rows: Awaited<ReturnType<MembershipReader["listMembershipsForUser"]>>;
      try {
        rows = await memberships.listMembershipsForUser(verified.value);
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Membership lookup is unavailable",
          input.correlationId,
          true,
        );
      }
      return {
        ok: true,
        value: rows
          .filter((row) => isContractRole(row.role))
          .map((row) => ({
            organizationId: row.organizationId,
            membershipId: row.membershipId,
            name: row.organizationName,
            slug: row.organizationSlug,
            role: row.role as AvailableOrganization["role"],
          })),
      };
    },

    async switchOrganization(input: {
      headers: Headers;
      organizationId: string;
      correlationId: string;
    }): Promise<Result<{ organizationId: string }>> {
      const verified = await verifiedUserId(input.headers, input.correlationId);
      if (!verified.ok) return verified;
      if (!input.organizationId)
        return failure(
          "VALIDATION",
          "An organization must be selected",
          input.correlationId,
        );

      // Membership is checked live before the session selection changes, so a
      // foreign or removed membership can never become the active organization.
      const resolved = await authorization.resolve(
        verified.value,
        input.organizationId,
        input.correlationId,
      );
      if (!resolved.ok) return resolved;

      try {
        await auth.api.setActiveOrganization({
          body: { organizationId: input.organizationId },
          headers: input.headers,
        });
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Organization selection is unavailable",
          input.correlationId,
          true,
        );
      }
      return { ok: true, value: { organizationId: input.organizationId } };
    },

    async signOutEverywhere(input: {
      headers: Headers;
      correlationId: string;
    }): Promise<Result<void>> {
      const verified = await verifiedUserId(input.headers, input.correlationId);
      if (!verified.ok) return verified;
      try {
        await auth.api.revokeSessions({ headers: input.headers });
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Session revocation is unavailable",
          input.correlationId,
          true,
        );
      }
      return { ok: true, value: undefined };
    },

    // Invitation creation surfaces a bounded delivery failure while keeping the
    // pending invitation for retry; authorization is the library's owner-only rule.
    async createInvitation(input: {
      headers: Headers;
      organizationId: string;
      email: string;
      role: string;
      correlationId: string;
    }): Promise<Result<{ invitationId: string; headers?: Headers }>> {
      const failuresBefore = mailFailures.filter(
        (entry) => entry.kind === "invitation",
      ).length;
      let created: { id: string } | null;
      let responseHeaders: Headers | undefined;
      try {
        const response = await auth.api.createInvitation({
          body: {
            email: input.email,
            role: input.role as
              | "owner"
              | "coordinator"
              | "volunteer"
              | "report-reader",
            organizationId: input.organizationId,
          },
          headers: input.headers,
          returnHeaders: true,
        });
        created = response.response;
        responseHeaders = response.headers;
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Invitation could not be created",
          input.correlationId,
          false,
        );
      }
      if (!created?.id)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Invitation could not be created",
          input.correlationId,
        );
      const failuresAfter = mailFailures.filter(
        (entry) => entry.kind === "invitation",
      ).length;
      if (failuresAfter > failuresBefore)
        // The invitation row is pending and can be re-sent; delivery failed.
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Invitation delivery is unavailable",
          input.correlationId,
          true,
        );
      const value: { invitationId: string; headers?: Headers } = {
        invitationId: created.id,
      };
      if (responseHeaders) value.headers = responseHeaders;
      return { ok: true, value };
    },

    // Accepts the emailed secret only for the verified matching recipient; the
    // library enforces recipient, expiry, single-use and email verification.
    async acceptInvitation(input: {
      headers: Headers;
      invitationId: string;
      correlationId: string;
    }): Promise<Result<{ organizationId: string | null }>> {
      try {
        const accepted = await auth.api.acceptInvitation({
          body: { invitationId: input.invitationId },
          headers: input.headers,
        });
        return {
          ok: true,
          value: {
            organizationId: accepted?.invitation.organizationId ?? null,
          },
        };
      } catch {
        return failure(
          "FORBIDDEN",
          "Invitation cannot be accepted",
          input.correlationId,
        );
      }
    },

    // Consumes the single-use reset token and invalidates that account's sessions.
    async resetPassword(input: {
      token: string;
      newPassword: string;
      correlationId: string;
    }): Promise<Result<{ reset: true }>> {
      let ownerId: string | null = null;
      try {
        const rows = await db.execute(resetTokenLookup(input.token));
        const row = rows.rows[0] as { value?: string } | undefined;
        ownerId = row?.value ?? null;
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Password reset is unavailable",
          input.correlationId,
          true,
        );
      }
      try {
        await auth.api.resetPassword({
          body: { newPassword: input.newPassword, token: input.token },
        });
      } catch {
        // Expired, used or unknown tokens all fail closed without detail.
        return failure(
          "VALIDATION",
          "Password reset cannot be completed",
          input.correlationId,
        );
      }
      if (ownerId) {
        try {
          await db.execute(revokeSessionsForUser(ownerId));
        } catch {
          return failure(
            "DEPENDENCY_UNAVAILABLE",
            "Session invalidation is unavailable",
            input.correlationId,
            true,
          );
        }
      }
      return { ok: true, value: { reset: true } };
    },

    // Non-enumerating by construction: unknown accounts and unknown redirect
    // targets produce the same accepted result as a real request, and transport
    // detail never leaves this boundary.
    async requestPasswordReset(input: {
      headers?: Headers;
      email: string;
      redirectTo?: string;
      correlationId: string;
    }): Promise<Result<{ accepted: true }>> {
      if (!mailConfigured)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Password reset delivery is not configured",
          input.correlationId,
          false,
        );
      try {
        const redirectTo = allowedRedirect(input.redirectTo);
        const request = {
          body: {
            email: input.email,
            ...(redirectTo ? { redirectTo } : {}),
          },
          ...(input.headers ? { headers: input.headers } : {}),
        };
        await auth.api.requestPasswordReset(request);
      } catch {
        // Includes transport failure; the pending token stays for a retry.
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Password reset delivery is unavailable",
          input.correlationId,
          true,
        );
      }
      return { ok: true, value: { accepted: true } };
    },
  };
}

// Single-use token owner, read before the library consumes the row.
const resetTokenLookup = (token: string) =>
  sql`select value from "verification" where identifier = ${`reset-password:${token}`} limit 1`;

// Password reset invalidates every prior session for that account.
const revokeSessionsForUser = (userId: string) =>
  sql`delete from "session" where user_id = ${userId}`;

export type SessionResolver = ReturnType<typeof createSessionResolver>;
