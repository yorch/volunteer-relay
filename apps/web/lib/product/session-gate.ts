import type { ErrorCode } from "@relay/contracts";

/**
 * Decides whether a Better Auth session may act in a tenant-scoped product
 * request, before any membership is read.
 *
 * - No user id: UNAUTHENTICATED.
 * - An email that is not verified: FORBIDDEN, exactly as for a user without
 *   any membership. Membership is only ever created for a verified email
 *   (invitation acceptance requires it, and provisioning selects verified
 *   users), so this is defense in depth rather than a reachable path. Better
 *   Auth does not require verification at sign-in (an unverified user must be
 *   able to sign in to verify and see invitations), so the session alone does
 *   not imply a verified email. FORBIDDEN, not UNAUTHENTICATED, keeps the
 *   workspace on its zero-organization panel instead of sending a signed-in
 *   user back to a sign-in page that cannot help.
 *
 * The auth endpoints that must work before verification (sign-out,
 * verification request/confirm and the pending-invitations list) do not use
 * this gate.
 */
export function productSessionUser(
  session:
    | {
        user?: {
          id?: string | null | undefined;
          emailVerified?: boolean | null | undefined;
        } | null;
      }
    | null
    | undefined,
): { ok: true; userId: string } | { ok: false; code: ErrorCode } {
  const user = session?.user;
  if (!user?.id) return { ok: false, code: "UNAUTHENTICATED" };
  if (user.emailVerified !== true) return { ok: false, code: "FORBIDDEN" };
  return { ok: true, userId: user.id };
}
