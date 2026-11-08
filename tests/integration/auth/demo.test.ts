import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { type Auth, createAuth } from "../../../apps/web/lib/auth/auth.ts";
import { provisionDemo } from "../../../apps/web/lib/auth/demo.ts";
import { createSessionResolver } from "../../../apps/web/lib/auth/session.ts";
import {
  createMembershipReader,
  type Database,
  eq,
  schema,
  seedOrganizations,
} from "../../../packages/db/src/index.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import { countRows, openTestDatabase, resetAuthTables } from "./support.ts";

let db: Database;
let close: () => Promise<void>;
let auth: Auth;
const profile = { DEMO_MODE: "true", NODE_ENV: "test" };
// Independent test oracle: deliberately authored role roster and public input.
const password = "Public-Synthetic-Demo-Only-2026!";
const roster = [
  { key: "owner", role: "owner", permissions: [true, true, true, true] },
  {
    key: "coordinator",
    role: "coordinator",
    permissions: [true, true, true, true],
  },
  {
    key: "volunteer",
    role: "volunteer",
    permissions: [true, false, false, false],
  },
  {
    key: "reader",
    role: "report-reader",
    permissions: [false, false, false, true],
  },
  { key: "multi", role: "owner", permissions: [true, true, true, true] },
];
const provision = () => provisionDemo({ db, auth }, ["--demo"], profile);

beforeAll(async () => {
  ({ db, close } = await openTestDatabase());
  auth = createAuth({
    db,
    secret: "synthetic-demo-test-secret-".padEnd(48, "x"),
    baseURL: "http://127.0.0.1:3174",
  });
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetAuthTables(db);
});

async function snapshot() {
  return {
    users: await db.select().from(schema.user).orderBy(schema.user.id),
    accounts: await db.select().from(schema.account).orderBy(schema.account.id),
    members: await db.select().from(schema.member).orderBy(schema.member.id),
    organizations: await db
      .select()
      .from(schema.organization)
      .orderBy(schema.organization.id),
  };
}

it.each([
  { args: [], env: profile },
  { args: ["--demo"], env: { NODE_ENV: "test" } },
  { args: ["--demo"], env: { ...profile, DEMO_MODE: "false" } },
  { args: ["--demo"], env: { ...profile, NODE_ENV: "production" } },
  { args: ["--demo"], env: { DEMO_MODE: "true" } },
  { args: ["--demo", "--force"], env: profile },
])(
  "refuses invalid profile before touching dependencies: $args $env",
  async ({ args, env }) => {
    const before = await snapshot();
    const inaccessible = new Proxy({} as { db: Database; auth: Auth }, {
      get() {
        throw new Error("Dependency touched before guard");
      },
    });
    await expect(provisionDemo(inaccessible, args, env)).rejects.toThrow(
      "requires --demo",
    );
    expect(await snapshot()).toEqual(before);
    const cli = spawnSync(
      process.execPath,
      ["apps/web/lib/auth/demo-cli.ts", ...args],
      {
        env: {
          ...process.env,
          DEMO_MODE: "",
          NODE_ENV: "",
          ...env,
          DATABASE_URL: "postgres://invalid.invalid/no_connection_allowed",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("Demo provisioning refused");
    expect(cli.stdout).toBe("");
    expect(cli.stderr).not.toContain(password);
  },
);

it("runs the explicit development CLI with a bounded create/reuse summary", async () => {
  function runCli() {
    return spawnSync(
      process.execPath,
      ["apps/web/lib/auth/demo-cli.ts", "--demo"],
      {
        env: {
          ...process.env,
          DEMO_MODE: "true",
          NODE_ENV: "development",
          DATABASE_URL: process.env.TEST_DATABASE_URL,
          APP_URL: "http://127.0.0.1:3174",
          BETTER_AUTH_SECRET: "public-synthetic-cli-test-secret-".padEnd(
            48,
            "x",
          ),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
  }
  const created = runCli();
  expect(created.status).toBe(0);
  expect(created.stderr).toBe("");
  expect(created.stdout.trim()).toBe(
    "Synthetic demo profile ready { createdUsers: 5, reusedUsers: 0 }",
  );
  const before = await snapshot();
  const reused = runCli();
  expect(reused.status).toBe(0);
  expect(reused.stdout.trim()).toBe(
    "Synthetic demo profile ready { createdUsers: 0, reusedUsers: 5 }",
  );
  expect(await snapshot()).toEqual(before);
});

it("creates the explicit profile and repeats without changing any row or hash", async () => {
  expect(await provision()).toEqual({ createdUsers: 5, reusedUsers: 0 });
  const before = await snapshot();
  expect(await provision()).toEqual({ createdUsers: 0, reusedUsers: 5 });
  expect(await snapshot()).toEqual(before);
  expect(before.organizations.map((o) => o.id)).toEqual(["harbor", "tidepath"]);
  expect(before.members).toHaveLength(6);
  expect(before.users.every((u) => u.emailVerified)).toBe(true);
  expect(before.accounts.every((a) => a.password !== password)).toBe(true);
  expect(await countRows(db, "session")).toBe(0);
  expect(await countRows(db, "verification")).toBe(0);
});

it("keeps ordinary seeds credential-free and preserves their fictional population", async () => {
  await seedOrganizations(db);
  const ordinary = await snapshot();
  expect(ordinary.accounts).toHaveLength(0);
  await provision();
  const after = await snapshot();
  for (const row of ordinary.users) expect(after.users).toContainEqual(row);
  for (const row of ordinary.members) expect(after.members).toContainEqual(row);
  expect(after.accounts).toHaveLength(5);
});

it.each(["email", "id", "tenant", "slug"])(
  "preserves conflicting existing %s rows without partial provisioning",
  async (kind) => {
    if (kind === "email" || kind === "id")
      await db.insert(schema.user).values({
        id: kind === "id" ? "demo-multi" : "unrelated",
        name: "Unrelated Synthetic",
        email:
          kind === "email"
            ? "DEMO-MULTI@example.invalid"
            : "unrelated@example.invalid",
      });
    else
      await db.insert(schema.organization).values({
        id: kind === "tenant" ? "harbor" : "different",
        slug: "harbor",
        name: "Unrelated Tenant",
      });
    const before = await snapshot();
    await expect(provision()).rejects.toThrow("Demo provisioning refused");
    expect(await snapshot()).toEqual(before);
  },
);

it.each(["password", "membership", "partial", "extra-membership"])(
  "does not repair or overwrite modified %s",
  async (kind) => {
    await provision();
    if (kind === "password")
      await db
        .update(schema.account)
        .set({
          password: await (await auth.$context).password.hash(
            "Changed-Synthetic-Password!",
          ),
        })
        .where(eq(schema.account.id, "demo-multi"));
    if (kind === "membership")
      await db
        .update(schema.member)
        .set({ role: "volunteer" })
        .where(eq(schema.member.id, "harbor-demo-multi"));
    if (kind === "partial")
      await db
        .delete(schema.account)
        .where(eq(schema.account.id, "demo-multi"));
    if (kind === "extra-membership")
      await db.insert(schema.member).values({
        id: "extra-demo-owner",
        userId: "demo-owner",
        organizationId: "harbor",
        role: "owner",
      });
    const before = await snapshot();
    await expect(provision()).rejects.toThrow("Demo provisioning refused");
    expect(await snapshot()).toEqual(before);
  },
);

it("rolls back all rows on a mid-provision hashing failure with bounded errors", async () => {
  const context = await auth.$context;
  const broken = {
    $context: Promise.resolve({
      ...context,
      password: {
        ...context.password,
        hash: async () => {
          throw new Error("private-driver-or-password-detail");
        },
      },
    }),
  };
  await expect(
    provisionDemo({ db, auth: broken }, ["--demo"], profile),
  ).rejects.toThrow(
    /^Demo provisioning refused: conflict or unavailable dependency$/,
  );
  expect(await countRows(db, "user")).toBe(0);
  expect(await countRows(db, "organization")).toBe(0);
});

it("serializes repeated concurrent calls without duplicate identities", async () => {
  const results = await Promise.all([provision(), provision()]);
  expect(results.map((r) => r.createdUsers).sort()).toEqual([0, 5]);
  expect(await countRows(db, "account")).toBe(5);
  expect(await countRows(db, "member")).toBe(6);
});

it("signs in four roles and multi-membership through verified sessions and live authorization", async () => {
  await provision();
  const memberships = createMembershipReader(db);
  const authorization = createAuthorizationService({ memberships });
  const resolver = createSessionResolver({
    auth,
    authorization,
    memberships,
    appUrl: "http://127.0.0.1:3174",
    mailConfigured: false,
  });
  for (const person of roster) {
    const response = await auth.api.signInEmail({
      body: { email: `demo-${person.key}@example.invalid`, password },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; "),
    });
    const context = await resolver.resolveVerifiedContext({
      headers,
      organizationId: "tidepath",
      correlationId: "demo-test",
    });
    expect(context.ok).toBe(true);
    if (!context.ok) throw new Error("Expected context");
    expect(context.value.actor).toMatchObject({ role: person.role });
    const permissions = [
      "source:submit",
      "review:write",
      "need:manage",
      "report:read",
    ] as const;
    for (const [index, permission] of permissions.entries())
      expect((await authorization.require(context.value, permission)).ok).toBe(
        person.permissions[index],
      );
    const harbor = await resolver.resolveVerifiedContext({
      headers,
      organizationId: "harbor",
      correlationId: "demo-test",
    });
    expect(harbor.ok).toBe(person.key === "multi");
    if (harbor.ok) {
      expect(harbor.value.actor).toMatchObject({ role: "report-reader" });
      expect(
        (await authorization.require(harbor.value, "report:read")).ok,
      ).toBe(true);
      expect(
        (await authorization.require(harbor.value, "source:submit")).ok,
      ).toBe(false);
      await db
        .delete(schema.member)
        .where(eq(schema.member.id, "harbor-demo-multi"));
      expect(
        (await authorization.require(harbor.value, "report:read")).ok,
      ).toBe(false);
      expect(
        (
          await resolver.resolveVerifiedContext({
            headers,
            organizationId: "harbor",
            correlationId: "demo-test",
          })
        ).ok,
      ).toBe(false);
    }
  }
});
