import { parseEnvironment } from "@relay/config";
import {
  createLastOrganizationStore,
  type Database,
  schema,
  sql,
} from "@relay/db";
import type { ContractRole } from "@relay/domain/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { createTenantAuthorization } from "./authorization.ts";
import { recordMailDeliveryFailure } from "./delivery.ts";
import { createLastOrganizationHints } from "./last-organization.ts";
import type { AuthMailCallbacks } from "./mail.ts";
import {
  createEmailVerification,
  maxOutstandingTokensPerUser,
} from "./verification.ts";

// Two layers share one statement set:
// - the four tenant permissions from @relay/contracts (domain authority), and
// - the resources Better Auth's organization endpoints check for themselves.
// The plugin's own admin/member roles are deliberately not granted, because the
// database accepts only contract roles.
const statement = {
  source: ["submit"],
  review: ["write"],
  need: ["manage"],
  report: ["read"],
  organization: ["update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
} as const;

const access = createAccessControl(statement);

// Owner administers the tenant; coordinator runs review/needs; volunteer submits
// sources; report-reader reads aggregates. member.role has a matching database
// check constraint, so an out-of-contract role cannot be stored.
const roles = {
  owner: access.newRole({
    source: ["submit"],
    review: ["write"],
    need: ["manage"],
    report: ["read"],
    organization: ["update", "delete"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  coordinator: access.newRole({
    source: ["submit"],
    review: ["write"],
    need: ["manage"],
    report: ["read"],
  }),
  volunteer: access.newRole({ source: ["submit"] }),
  "report-reader": access.newRole({ report: ["read"] }),
};

export interface AuthPolicy {
  sessionExpiresInSec: number;
  sessionUpdateAgeSec: number;
  resetTokenExpiresInSec: number;
  invitationExpiresInSec: number;
  // Public credential sign-up is enabled by default, matching the documented
  // /api/auth/sign-up route. A deployment that must be invite-only sets false.
  allowCredentialSignUp: boolean;
}

export const defaultAuthPolicy: AuthPolicy = {
  sessionExpiresInSec: 7 * 24 * 60 * 60,
  sessionUpdateAgeSec: 24 * 60 * 60,
  resetTokenExpiresInSec: 60 * 60,
  invitationExpiresInSec: 48 * 60 * 60,
  allowCredentialSignUp: true,
};

export interface AuthDependencies {
  db: Database;
  secret: string;
  baseURL: string;
  // Injected transport. Absent, email-dependent endpoints are refused by the
  // server helpers instead of silently succeeding without delivering.
  mail?: AuthMailCallbacks;
  policy?: Partial<AuthPolicy>;
}

const invitationAcceptPath = "/invitations";
// Better Auth stores reset tokens as `reset-password:<token>` with the user id
// as the value.
const resetIdentifierPrefix = "reset-password:";

export function createAuth({
  db,
  secret,
  baseURL,
  mail,
  policy: policyOverrides,
}: AuthDependencies) {
  const policy: AuthPolicy = { ...defaultAuthPolicy, ...policyOverrides };

  // Transport failures are never rethrown with driver detail: the pending
  // token/invitation row stays available for a retry, and no token reaches a
  // caller-visible error. The failure kind is recorded for the enclosing
  // trackMailDelivery call so a server helper can report it per request.
  const sendResetPassword = mail
    ? async ({
        user,
        url,
        token,
      }: {
        user: { email: string; name?: string | null };
        url: string;
        token: string;
      }) => {
        try {
          await mail.sendPasswordReset({
            to: user.email,
            name: user.name ?? "",
            resetUrl: url,
            token,
          });
        } catch {
          // Not surfaced by the reset helper: only existing accounts reach the
          // transport, so reporting it would enumerate accounts.
          recordMailDeliveryFailure("reset");
        }
      }
    : undefined;

  const sendInvitationEmail = mail
    ? async (data: {
        id: string;
        role: string;
        email: string;
        organization: { name: string };
        inviter: { user: { name?: string | null } };
        invitation: { expiresAt: Date };
      }) => {
        try {
          await mail.sendInvitation({
            to: data.email,
            organizationName: data.organization.name,
            role: data.role as ContractRole,
            invitationId: data.id,
            inviterName: data.inviter.user.name ?? "",
            acceptPath: `${invitationAcceptPath}/${data.id}`,
            expiresAt: data.invitation.expiresAt,
          });
        } catch {
          // As above: bounded failure, no token or recipient in the error path.
          recordMailDeliveryFailure("invitation");
        }
      }
    : undefined;

  const lastOrganization = createLastOrganizationHints({
    store: createLastOrganizationStore(db),
    authorization: createTenantAuthorization({ db }),
  });

  const auth = betterAuth({
    disabledPaths: ["/verify-email", "/send-verification-email"],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path === "/verify-email" ||
          ctx.path === "/send-verification-email"
        ) {
          throw new APIError("FORBIDDEN", {
            message: "Use application verification",
          });
        }
      }),
    },
    secret,
    baseURL,
    databaseHooks: {
      session: {
        create: {
          // Every new session (credential sign-in, sign-up auto sign-in, any
          // later sign-in path) starts in the user's last-used organization
          // when that membership still resolves live; otherwise the user picks.
          // The selection is never authority: each request re-resolves it.
          before: async (row: {
            userId: string;
            activeOrganizationId?: string | null;
          }) => {
            if (row.activeOrganizationId) return;
            const organizationId = await lastOrganization.resolve(row.userId);
            if (!organizationId) return;
            return { data: { ...row, activeOrganizationId: organizationId } };
          },
        },
      },
      verification: {
        create: {
          // Caps outstanding reset tokens per account: each request beyond the
          // cap invalidates the oldest pending token, and expired ones go too.
          after: async (row: { identifier: string; value: string }) => {
            if (!row.identifier.startsWith(resetIdentifierPrefix)) return;
            try {
              await db.execute(sql`
                delete from verification
                where identifier like ${`${resetIdentifierPrefix}%`} and value = ${row.value}
                  and id not in (
                    select id from verification
                    where identifier like ${`${resetIdentifierPrefix}%`} and value = ${row.value}
                      and expires_at > now()
                    order by created_at desc, id desc
                    limit ${maxOutstandingTokensPerUser}
                  )
              `);
            } catch {
              // Best effort: a failed prune must not make a reset response
              // differ for existing accounts. Expiry still bounds the tokens.
            }
          },
        },
      },
    },
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    session: {
      expiresIn: policy.sessionExpiresInSec,
      updateAge: policy.sessionUpdateAgeSec,
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !policy.allowCredentialSignUp,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: policy.resetTokenExpiresInSec,
      ...(sendResetPassword ? { sendResetPassword } : {}),
    },
    plugins: [
      organization({
        ac: access,
        roles,
        // Acceptance requires the signed-in recipient's email to be verified,
        // not merely declared, and the library also enforces recipient/expiry/
        // single-use. Out-of-contract roles are rejected by the roles map below.
        requireEmailVerificationOnInvitation: true,
        // Organizations are created by provisioning or the platform operator
        // console, never by a signed-in user; deletion has no supported path yet
        // (the audit and ledger rows are not disposable). Keeping both off means
        // an unreachable library endpoint cannot bypass those rules.
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        invitationExpiresIn: policy.invitationExpiresInSec,
        ...(sendInvitationEmail ? { sendInvitationEmail } : {}),
      }),
    ],
  });
  return Object.assign(auth, {
    emailVerification: createEmailVerification(db, baseURL, mail),
    lastOrganization,
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Server-side factory: the secret is validated by the shared environment schema
// and never logged. Credential rows belong to an explicit demo profile.
export function createAuthFromEnvironment(
  db: Database,
  env: Record<string, string | undefined> = process.env,
) {
  const config = parseEnvironment(env);
  if (!config.BETTER_AUTH_SECRET)
    throw new Error(
      "BETTER_AUTH_SECRET is required to configure authentication",
    );
  return createAuth({
    db,
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.APP_URL,
  });
}
