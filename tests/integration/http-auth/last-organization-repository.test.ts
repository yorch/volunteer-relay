import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLastOrganizationStore,
  type Database,
  eq,
  type LastOrganizationStore,
  schema,
  seedOrganizations,
  sql,
} from "../../../packages/db/src/index.ts";
import {
  expectDatabaseRejection,
  openTestDatabase,
  resetAuthTables,
} from "../auth/support.ts";

// Requires TEST_DATABASE_URL naming a private *_test database; the suite
// migrates it and truncates only the auth tables (the hint cascades with user).
const { member, organization, user, userLastOrganization } = schema;

let db: Database;
let close: () => Promise<void>;
let store: LastOrganizationStore;

async function person(id: string, memberOf: string[]) {
  await db
    .insert(user)
    .values({ id, name: "Synthetic Person", email: `${id}@example.invalid` });
  for (const organizationId of memberOf)
    await db.insert(member).values({
      id: `${organizationId}-${id}`,
      organizationId,
      userId: id,
      role: "volunteer",
    });
}

async function hintRows(userId: string) {
  return db
    .select()
    .from(userLastOrganization)
    .where(eq(userLastOrganization.userId, userId));
}

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  store = createLastOrganizationStore(db);
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await resetAuthTables(db);
  await seedOrganizations(db);
});

describe("last-used organization store", () => {
  it("reads nothing before a hint is written", async () => {
    await person("hint-ana", ["tidepath"]);
    expect(await store.read("hint-ana")).toBeNull();
    expect(await store.read("")).toBeNull();
  });

  it("sets, upserts and keeps exactly one row per user", async () => {
    await person("hint-ana", ["tidepath", "harbor"]);
    await store.remember({ userId: "hint-ana", organizationId: "tidepath" });
    expect(await store.read("hint-ana")).toBe("tidepath");
    const [first] = await hintRows("hint-ana");

    await store.remember({ userId: "hint-ana", organizationId: "harbor" });
    expect(await store.read("hint-ana")).toBe("harbor");
    const rows = await hintRows("hint-ana");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedAt.getTime()).toBeGreaterThanOrEqual(
      first?.updatedAt.getTime() ?? 0,
    );
  });

  it("clears only the hint that still names the organization", async () => {
    await person("hint-ana", ["tidepath", "harbor"]);
    await store.remember({ userId: "hint-ana", organizationId: "harbor" });

    // A stale cleanup for another organization never erases the newer hint.
    await store.forget({ userId: "hint-ana", organizationId: "tidepath" });
    expect(await store.read("hint-ana")).toBe("harbor");

    await store.forget({ userId: "hint-ana", organizationId: "harbor" });
    expect(await store.read("hint-ana")).toBeNull();
  });

  it("rejects a hint for an organization without membership", async () => {
    await person("hint-ana", ["tidepath"]);
    await expectDatabaseRejection(
      () => store.remember({ userId: "hint-ana", organizationId: "harbor" }),
      "23503",
    );
    await expectDatabaseRejection(
      () => store.remember({ userId: "hint-ghost", organizationId: "harbor" }),
      "23503",
    );
    expect(await store.read("hint-ana")).toBeNull();
  });

  it("removes the hint when the membership is removed", async () => {
    await person("hint-ana", ["tidepath", "harbor"]);
    await store.remember({ userId: "hint-ana", organizationId: "harbor" });
    await db.delete(member).where(eq(member.id, "harbor-hint-ana"));
    expect(await hintRows("hint-ana")).toHaveLength(0);
  });

  it("removes the hint when the organization is deleted", async () => {
    await db
      .insert(organization)
      .values({ id: "hint-org", name: "Hint Org", slug: "hint-org" });
    await person("hint-ana", ["tidepath", "hint-org"]);
    await store.remember({ userId: "hint-ana", organizationId: "hint-org" });
    await db.delete(organization).where(eq(organization.id, "hint-org"));
    expect(await store.read("hint-ana")).toBeNull();
  });

  it("removes the hint when the user is deleted", async () => {
    await person("hint-ana", ["tidepath"]);
    await store.remember({ userId: "hint-ana", organizationId: "tidepath" });
    await db.delete(user).where(eq(user.id, "hint-ana"));
    const count = await db.execute(
      sql`select count(*)::int as count from user_last_organization`,
    );
    expect((count.rows[0] as { count: number }).count).toBe(0);
  });

  it("serializes concurrent writes into one consistent row", async () => {
    await person("hint-ana", ["tidepath", "harbor"]);
    const writes = Array.from({ length: 20 }, (_, index) =>
      store.remember({
        userId: "hint-ana",
        organizationId: index % 2 === 0 ? "tidepath" : "harbor",
      }),
    );
    await Promise.all(writes);
    const rows = await hintRows("hint-ana");
    expect(rows).toHaveLength(1);
    expect(["tidepath", "harbor"]).toContain(rows[0]?.organizationId);
  });
});
