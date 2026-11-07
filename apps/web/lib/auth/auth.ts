import { parseEnvironment } from "@relay/config";
import { type Database, schema } from "@relay/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";

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

export interface AuthDependencies {
  db: Database;
  secret: string;
  baseURL: string;
}

export function createAuth({ db, secret, baseURL }: AuthDependencies) {
  return betterAuth({
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [organization({ ac: access, roles })],
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
