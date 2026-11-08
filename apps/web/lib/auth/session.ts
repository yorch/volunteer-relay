import type {
  ApiError,
  AuthOrganizationOption,
  AuthorizationService,
  AuthVerificationConfirm,
  AuthVerificationRequest,
  Result,
  TenantContext,
} from "@relay/contracts";
import type { MembershipReader } from "@relay/db";
import { isContractRole } from "@relay/domain/auth";
import { APIError } from "better-auth/api";
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

// Callers forward a per-call responseHeaders collector to their HTTP response,
// including when a later authorization step returns a denial.
export interface SessionResolverDependencies {
  auth: Auth;
  authorization: AuthorizationService;
  memberships: MembershipReader;
  mailFailures?: Array<{ kind: "reset" | "invitation" | "verification" }>;
  // Application origin used to constrain password-reset redirect targets.
  appUrl: string;
  // Whether a mail transport is configured; without one, reset requests are
  // refused with a bounded error instead of silently succeeding.
  mailConfigured: boolean;
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
  mailFailures = [],
  appUrl,
  mailConfigured,
}: SessionResolverDependencies) {
  async function verifiedUserId(
    headers: Headers,
    correlationId: string,
    responseHeaders?: Headers,
  ): Promise<Result<string>> {
    try {
      const result = await auth.api.getSession({
        headers,
        returnHeaders: true,
      });
      collectHeaders(result.headers, responseHeaders);
      // Absent, expired or malformed cookies all read as no session.
      if (!result.response?.user?.id)
        return failure("UNAUTHENTICATED", "Sign-in is required", correlationId);
      return { ok: true, value: result.response.user.id };
    } catch {
      return failure(
        "DEPENDENCY_UNAVAILABLE",
        "Session service is unavailable",
        correlationId,
        true,
      );
    }
  }

  async function resolveMembership(
    userId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<Result<TenantContext>> {
    try {
      return await authorization.resolve(userId, organizationId, correlationId);
    } catch {
      return failure(
        "DEPENDENCY_UNAVAILABLE",
        "Authorization service is unavailable",
        correlationId,
        true,
      );
    }
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
    async requestEmailVerification(
      input: AuthVerificationRequest & {
        correlationId: string;
        responseHeaders?: Headers;
      },
    ): Promise<Result<void>> {
      if (!auth.emailVerification.configured)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Email verification delivery is not configured",
          input.correlationId,
        );
      try {
        await auth.emailVerification.request(input.email);
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Email verification is unavailable",
          input.correlationId,
          true,
        );
      }
      return { ok: true, value: undefined };
    },
    async confirmEmailVerification(
      input: AuthVerificationConfirm & {
        correlationId: string;
        responseHeaders?: Headers;
      },
    ): Promise<Result<void>> {
      try {
        if (!(await auth.emailVerification.confirm(input.token)))
          return failure(
            "VALIDATION",
            "Email verification cannot be completed",
            input.correlationId,
          );
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Email verification is unavailable",
          input.correlationId,
          true,
        );
      }
      return { ok: true, value: undefined };
    },
    async resolveVerifiedContext(input: {
      headers: Headers;
      responseHeaders?: Headers;
      organizationId: string | null | undefined;
      correlationId: string;
    }): Promise<Result<TenantContext>> {
      const verified = await verifiedUserId(
        input.headers,
        input.correlationId,
        input.responseHeaders,
      );
      if (!verified.ok) return verified;
      if (!input.organizationId)
        return failure(
          "VALIDATION",
          "An organization must be selected",
          input.correlationId,
        );
      // Live membership decides; a session active-organization value never does.
      return resolveMembership(
        verified.value,
        input.organizationId,
        input.correlationId,
      );
    },

    async listAvailableOrganizations(input: {
      headers: Headers;
      responseHeaders?: Headers;
      correlationId: string;
    }): Promise<Result<AuthOrganizationOption[]>> {
      const verified = await verifiedUserId(
        input.headers,
        input.correlationId,
        input.responseHeaders,
      );
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
            role: row.role as AuthOrganizationOption["role"],
          })),
      };
    },

    async switchOrganization(input: {
      headers: Headers;
      responseHeaders?: Headers;
      organizationId: string;
      correlationId: string;
    }): Promise<Result<{ organizationId: string }>> {
      const verified = await verifiedUserId(
        input.headers,
        input.correlationId,
        input.responseHeaders,
      );
      if (!verified.ok) return verified;
      if (!input.organizationId)
        return failure(
          "VALIDATION",
          "An organization must be selected",
          input.correlationId,
        );

      // Membership is checked live before the session selection changes, so a
      // foreign or removed membership can never become the active organization.
      const resolved = await resolveMembership(
        verified.value,
        input.organizationId,
        input.correlationId,
      );
      if (!resolved.ok) return resolved;

      try {
        const response = await auth.api.setActiveOrganization({
          body: { organizationId: input.organizationId },
          headers: input.headers,
          returnHeaders: true,
        });
        collectHeaders(response.headers, input.responseHeaders);
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
      responseHeaders?: Headers;
      correlationId: string;
    }): Promise<Result<void>> {
      const verified = await verifiedUserId(
        input.headers,
        input.correlationId,
        input.responseHeaders,
      );
      if (!verified.ok) return verified;
      try {
        const response = await auth.api.revokeSessions({
          headers: input.headers,
          returnHeaders: true,
        });
        collectHeaders(response.headers, input.responseHeaders);
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
      responseHeaders?: Headers;
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
        collectHeaders(response.headers, input.responseHeaders);
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
      responseHeaders?: Headers;
      invitationId: string;
      correlationId: string;
    }): Promise<Result<{ organizationId: string | null }>> {
      try {
        const response = await auth.api.acceptInvitation({
          body: { invitationId: input.invitationId },
          headers: input.headers,
          returnHeaders: true,
        });
        collectHeaders(response.headers, input.responseHeaders);
        return {
          ok: true,
          value: {
            organizationId:
              response.response?.invitation.organizationId ?? null,
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
      try {
        await auth.api.resetPassword({
          body: { newPassword: input.newPassword, token: input.token },
        });
      } catch (error) {
        // Expected input/token denials remain validation failures; unexpected
        // adapter failures are safe and retryable after the reset rolls back.
        if (error instanceof APIError && error.statusCode < 500)
          return failure(
            "VALIDATION",
            "Password reset cannot be completed",
            input.correlationId,
          );
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Password reset is unavailable",
          input.correlationId,
          true,
        );
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

// Preserve separate Set-Cookie values (Expires may contain commas) and append
// successive renewal/selection cookies in order. The collector belongs to one call.
function collectHeaders(source: Headers, target?: Headers): void {
  if (!target) return;
  for (const [name, value] of source) {
    if (name.toLowerCase() !== "set-cookie") target.set(name, value);
  }
  for (const cookie of source.getSetCookie())
    target.append("set-cookie", cookie);
}

export type SessionResolver = ReturnType<typeof createSessionResolver>;
