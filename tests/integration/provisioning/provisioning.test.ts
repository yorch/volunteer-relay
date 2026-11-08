import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAuth } from "../../../apps/web/lib/auth/auth.ts";
import { type Database, sql } from "../../../packages/db/src/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

const execute = promisify(execFile);
let db: Database;
let close: () => Promise<void>;
const testUrl =
  "postgres://relay:relay@127.0.0.1:55482/relay_provisioning_test";
const cli = async (args: string[]) => {
  try {
    const result = await execute(
      process.execPath,
      ["scripts/provision-organization.ts", ...args],
      { env: { ...process.env, DATABASE_URL: testUrl } },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return {
      code: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
};
const args = (email: string, slug: string, timezone = "America/New_York") => [
  "--email",
  email,
  "--name",
  "Synthetic Organization",
  "--slug",
  slug,
  "--timezone",
  timezone,
];

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL !== testUrl)
    throw new Error("Use the dedicated relay_provisioning_test database");
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  await resetAuthTables(db);
  const auth = createAuth({
    db,
    secret: "synthetic-integration-secret".padEnd(40, "x"),
    baseURL: "http://localhost:3000",
  });
  for (const email of [
    "verified@example.invalid",
    "unverified@example.invalid",
    "no-credential@example.invalid",
  ]) {
    await auth.api.signUpEmail({
      body: {
        email,
        name: "Synthetic User",
        password: "synthetic-test-password-1",
      },
    });
  }
  await db.execute(
    sql`update "user" set email_verified=true where email in ('verified@example.invalid','no-credential@example.invalid')`,
  );
  await db.execute(
    sql`delete from account where user_id=(select id from "user" where email='no-credential@example.invalid')`,
  );
});
afterAll(async () => {
  await close?.();
});

it("creates one new organization, owner and review-all timezone settings, then refuses replay", async () => {
  const result = await cli(args("verified@example.invalid", "new-org"));
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const value = JSON.parse(result.stdout) as { organizationId: string };
  expect(Object.keys(value)).toEqual(["organizationId"]);
  const rows = await db.execute(
    sql`select o.id,o.name,o.slug,m.role,u.email,s.timezone,s.automation_policy,s.revision from organization o join member m on m.organization_id=o.id join "user" u on u.id=m.user_id join organization_settings s on s.organization_id=o.id where o.slug='new-org'`,
  );
  expect(rows.rows).toEqual([
    {
      id: value.organizationId,
      name: "Synthetic Organization",
      slug: "new-org",
      role: "owner",
      email: "verified@example.invalid",
      timezone: "America/New_York",
      automation_policy: "review-all",
      revision: 1,
    },
  ]);
  const repeated = await cli(args("verified@example.invalid", "new-org"));
  expect(repeated.code).not.toBe(0);
  expect(repeated.stdout).toBe("");
  const sameName = await cli(args("verified@example.invalid", "another-slug"));
  expect(sameName.code).not.toBe(0);
  expect(
    (
      await db.execute(
        sql`select id from organization where slug='another-slug'`,
      )
    ).rows,
  ).toEqual([]);
  const count = await db.execute(
    sql`select count(*)::int as count from member where organization_id=${value.organizationId}`,
  );
  expect(count.rows[0]?.count).toBe(1);
});

it("refuses missing, unverified, and passwordless users and invalid inputs without creating an organization", async () => {
  for (const [email, slug, timezone] of [
    ["absent@example.invalid", "absent-org", "UTC"],
    ["unverified@example.invalid", "unverified-org", "UTC"],
    ["no-credential@example.invalid", "no-credential-org", "UTC"],
    ["verified@example.invalid", "invalid-zone", "Not/AZone"],
    ["verified@example.invalid", "Invalid_Slug", "UTC"],
  ] as const) {
    const result = await cli(args(email, slug, timezone));
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  }
  const found = await db.execute(
    sql`select slug from organization where slug in ('absent-org','unverified-org','no-credential-org','invalid-zone','Invalid_Slug')`,
  );
  expect(found.rows).toEqual([]);
});

it("rolls back organization and owner when the settings insert fails", async () => {
  await db.execute(
    sql`alter table organization_settings add constraint provisioning_test_reject check (timezone <> 'Europe/Paris')`,
  );
  try {
    const rollbackArgs = args(
      "verified@example.invalid",
      "rollback-org",
      "Europe/Paris",
    );
    rollbackArgs[3] = "Rollback Organization";
    const result = await cli(rollbackArgs);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(
      (
        await db.execute(
          sql`select id from organization where slug='rollback-org'`,
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await db.execute(
      sql`alter table organization_settings drop constraint provisioning_test_reject`,
    );
  }
});

it("serializes concurrent attempts with the same new organization name", async () => {
  const first = args("verified@example.invalid", "concurrent-one", "UTC");
  const second = args("verified@example.invalid", "concurrent-two", "UTC");
  first[3] = "Concurrent Organization";
  second[3] = "Concurrent Organization";
  const results = await Promise.all([cli(first), cli(second)]);
  expect(results.filter((result) => result.code === 0)).toHaveLength(1);
  expect(
    (
      await db.execute(
        sql`select id from organization where name='Concurrent Organization'`,
      )
    ).rows,
  ).toHaveLength(1);
});
