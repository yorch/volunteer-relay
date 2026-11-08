import { parseEnvironment } from "@relay/config";
import { type Database, schema } from "@relay/db";
import type { ContractRole } from "@relay/domain/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import type { AuthMailCallbacks } from "./mail.ts";

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
  // Invite-only is the product default; tests and later demo profiles can opt in.
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

export function createAuth({
  db,
  secret,
  baseURL,
  mail,
  policy: policyOverrides,
}: AuthDependencies) {
  const policy: AuthPolicy = { ...defaultAuthPolicy, ...policyOverrides };

  // Transport failures are recorded by the transport itself and never rethrown
  // with driver detail: the pending token/invitation row stays available for a
  // retry, and no token reaches a caller-visible error.
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
          // Deliberately swallowed; the transport recorded the failure.
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
        }
      }
    : undefined;

  return betterAuth({
    secret,
    baseURL,
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
        invitationExpiresIn: policy.invitationExpiresInSec,
        ...(sendInvitationEmail ? { sendInvitationEmail } : {}),
      }),
    ],
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
