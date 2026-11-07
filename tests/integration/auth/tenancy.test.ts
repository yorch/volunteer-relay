import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  and,
  createMembershipReader,
  type Database,
  eq,
  schema,
  seedOrganizations,
  sql,
} from "../../../packages/db/src/index.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import {
  countRows,
  expectDatabaseRejection,
  openTestDatabase,
  resetAuthTables,
} from "./support.ts";

const { account, invitation, member, organization } = schema;

let db: Database;
let close: () => Promise<void>;

function authorization() {
  return createAuthorizationService({
    memberships: createMembershipReader(db),
  });
}

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await resetAuthTables(db);
  await seedOrganizations(db);
});

describe("synthetic tenant seed", () => {
  it("creates two tenants without credential rows", async () => {
    expect(await countRows(db, "organization")).toBe(2);
    expect(await countRows(db, "user")).toBe(5);
    expect(await countRows(db, "member")).toBe(6);
    expect(await countRows(db, "account")).toBe(0);
    expect(await countRows(db, "session")).toBe(0);

    const tenants = await db
      .select({ id: organization.id, slug: organization.slug })
      .from(organization)
      .orderBy(organization.id);
    expect(tenants).toEqual([
      { id: "harbor", slug: "harbor" },
      { id: "tidepath", slug: "tidepath" },
    ]);
  });

  it("is idempotent on a second run", async () => {
    const summary = await seedOrganizations(db);
    expect(summary).toEqual({
      organizations: 0,
      users: 0,
      memberships: 0,
    });
    expect(await countRows(db, "member")).toBe(6);
    expect(await countRows(db, "account")).toBe(0);
  });
});

describe("tenant resolution", () => {
  it("resolves each membership of a multi-membership user with its own role", async () => {
    const service = authorization();

    const tidepath = await service.resolve("user-rae", "tidepath", "corr-a");
    const harbor = await service.resolve("user-rae", "harbor", "corr-b");

    expect(tidepath).toEqual({
      ok: true,
      value: {
        organizationId: "tidepath",
        actor: {
          kind: "user",
          userId: "user-rae",
          membershipId: "tidepath-rae",
          role: "owner",
        },
        correlationId: "corr-a",
      },
    });
    expect(harbor).toEqual({
      ok: true,
      value: {
        organizationId: "harbor",
        actor: {
          kind: "user",
          userId: "user-rae",
          membershipId: "harbor-rae",
          role: "report-reader",
        },
        correlationId: "corr-b",
      },
    });
  });

  it("conceals another tenant's membership as NOT_FOUND", async () => {
    const service = authorization();

    const direct = await createMembershipReader(db).findMembership({
      userId: "user-mira",
      organizationId: "harbor",
    });
    expect(direct).toBeNull();

    const result = await service.resolve("user-mira", "harbor", "corr-c");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("NOT_FOUND");
    expect(result.error.message).toBe("Organization not available");
    expect(JSON.stringify(result)).not.toContain("tidepath");
  });

  it("does not treat a parsed context as authority for another tenant", async () => {
    const service = authorization();
    const resolved = await service.resolve("user-mira", "tidepath", "corr-d");
    if (!resolved.ok) throw new Error("expected context");

    const forged = { ...resolved.value, organizationId: "harbor" };
    const result = await service.require(forged, "source:submit");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("FORBIDDEN");
  });

  it("denies unknown users without leaking tenant existence", async () => {
    const service = authorization();
    const result = await service.resolve("user-nobody", "tidepath", "corr-e");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("permission decisions", () => {
  it("lets a volunteer submit sources but not review them", async () => {
    const service = authorization();
    const resolved = await service.resolve("user-mira", "tidepath", "corr-f");
    if (!resolved.ok) throw new Error("expected context");

    expect((await service.require(resolved.value, "source:submit")).ok).toBe(
      true,
    );
    const review = await service.require(resolved.value, "review:write");
    expect(review.ok).toBe(false);
    if (review.ok) throw new Error("expected failure");
    expect(review.error.code).toBe("FORBIDDEN");
  });

  it("keeps a report reader out of source submission in that tenant", async () => {
    const service = authorization();
    const harbor = await service.resolve("user-rae", "harbor", "corr-g");
    if (!harbor.ok) throw new Error("expected context");

    expect((await service.require(harbor.value, "report:read")).ok).toBe(true);
    const submit = await service.require(harbor.value, "source:submit");
    expect(submit.ok).toBe(false);

    const tidepath = await service.resolve("user-rae", "tidepath", "corr-h");
    if (!tidepath.ok) throw new Error("expected context");
    expect((await service.require(tidepath.value, "source:submit")).ok).toBe(
      true,
    );
  });

  it("denies a revoked membership and stops resolving it", async () => {
    const service = authorization();
    const resolved = await service.resolve("user-rae", "tidepath", "corr-i");
    if (!resolved.ok) throw new Error("expected context");

    await db.delete(member).where(eq(member.id, "tidepath-rae"));

    const denied = await service.require(resolved.value, "source:submit");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("expected failure");
    expect(denied.error.code).toBe("FORBIDDEN");
    expect(denied.error.message).toBe("Membership is no longer active");

    const revoked = await service.resolve("user-rae", "tidepath", "corr-j");
    expect(revoked.ok).toBe(false);
    if (revoked.ok) throw new Error("expected failure");
    expect(revoked.error.code).toBe("NOT_FOUND");

    // The other tenant's membership is untouched.
    expect((await service.resolve("user-rae", "harbor", "corr-k")).ok).toBe(
      true,
    );
  });

  it("applies a role change to the next decision", async () => {
    const service = authorization();
    const resolved = await service.resolve("user-rae", "tidepath", "corr-l");
    if (!resolved.ok) throw new Error("expected context");
    expect((await service.require(resolved.value, "need:manage")).ok).toBe(
      true,
    );

    await db
      .update(member)
      .set({ role: "volunteer" })
      .where(
        and(
          eq(member.id, "tidepath-rae"),
          eq(member.organizationId, "tidepath"),
        ),
      );

    const managed = await service.require(resolved.value, "need:manage");
    expect(managed.ok).toBe(false);
    if (managed.ok) throw new Error("expected failure");
    expect(managed.error.code).toBe("FORBIDDEN");
    expect((await service.require(resolved.value, "source:submit")).ok).toBe(
      true,
    );
  });
});

describe("tenant-scoped schema constraints", () => {
  it("rejects a second membership for the same tenant and user", async () => {
    await expectDatabaseRejection(
      () =>
        db.insert(member).values({
          id: "tidepath-mira-duplicate",
          organizationId: "tidepath",
          userId: "user-mira",
          role: "volunteer",
        }),
      "23505",
    );
  });

  it("rejects an out-of-contract role", async () => {
    await expectDatabaseRejection(
      () =>
        db.insert(member).values({
          id: "tidepath-mira-member",
          organizationId: "tidepath",
          userId: "user-mira",
          role: "member",
        }),
      "23514",
    );
    await expectDatabaseRejection(
      () =>
        db
          .update(member)
          .set({ role: "admin" })
          .where(eq(member.id, "tidepath-mira")),
      "23514",
    );
  });

  it("rejects an invitation with an out-of-contract role", async () => {
    await expectDatabaseRejection(
      () =>
        db.insert(invitation).values({
          id: "invitation-1",
          organizationId: "tidepath",
          email: "invitee@example.invalid",
          role: "member",
          status: "pending",
          expiresAt: new Date(Date.now() + 86_400_000),
          inviterId: "user-rae",
        }),
      "23514",
    );
  });

  it("rejects a membership for an unknown organization", async () => {
    await expectDatabaseRejection(
      () =>
        db.insert(member).values({
          id: "nowhere-mira",
          organizationId: "nowhere",
          userId: "user-mira",
          role: "volunteer",
        }),
      "23503",
    );
  });

  it("removes tenant memberships and credentials when a tenant is deleted", async () => {
    await db.insert(account).values({
      id: "account-nico",
      accountId: "user-nico",
      providerId: "credential",
      userId: "user-nico",
      password: "synthetic-not-a-real-hash",
    });

    await db.delete(organization).where(eq(organization.id, "harbor"));

    expect(await countRows(db, "member")).toBe(4);
    // Credentials belong to the user, not the tenant, so they survive.
    expect(await countRows(db, "account")).toBe(1);
    expect(await countRows(db, "user")).toBe(5);

    const service = authorization();
    const result = await service.resolve("user-nico", "harbor", "corr-m");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("keeps the tenant-scoped key on memberships usable for joins", async () => {
    const rows = await db.execute(
      sql`select organization_id, user_id, role from member where organization_id = 'tidepath' order by id`,
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows as Array<{ organization_id: string }>)
      expect(row.organization_id).toBe("tidepath");
    expect(await countRows(db, "user")).toBe(5);
  });
});
