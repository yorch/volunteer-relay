import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Auth, createAuth } from "../../../apps/web/lib/auth/auth.ts";
import {
  type Database,
  eq,
  schema,
  sql,
} from "../../../packages/db/src/index.ts";
import { countRows, openTestDatabase, resetAuthTables } from "./support.ts";

const { member, organization } = schema;

type Role = "owner" | "coordinator" | "volunteer" | "report-reader";

let db: Database;
let close: () => Promise<void>;
let auth: Auth;

const password = "synthetic-password-1";

function cookieHeaders(setCookie: string | null): Headers {
  const cookie = (setCookie ?? "")
    .split(",")
    .map((part) => part.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

async function signUp(email: string) {
  const result = await auth.api.signUpEmail({
    body: { email, password, name: "Synthetic Person" },
    returnHeaders: true,
  });
  return {
    headers: cookieHeaders(result.headers.get("set-cookie")),
    user: result.response.user,
  };
}

async function expectForbidden(action: Promise<unknown>, code: string) {
  try {
    await action;
  } catch (error) {
    const apiError = error as {
      status?: string | number;
      body?: { code?: string };
    };
    expect(apiError.body?.code).toBe(code);
    expect(String(apiError.status)).toContain("FORBIDDEN");
    return;
  }
  throw new Error(`Expected FORBIDDEN ${code}, but the call succeeded`);
}

interface Person {
  headers: Headers;
  organizationId: string;
}

// One tenant, four members, one contract role each. The owner is the creator;
// the other roles are added with explicit membership rows so the roster itself
// is subject to the role check constraint.
async function seedRoleRoster(): Promise<Record<Role, Person>> {
  const owner = await signUp("owner@example.invalid");
  const created = await auth.api.createOrganization({
    body: { name: "Role Boundary Cohort", slug: "role-boundary-cohort" },
    headers: owner.headers,
  });
  if (!created) throw new Error("expected an organization");

  async function addMember(
    role: "coordinator" | "volunteer" | "report-reader",
  ): Promise<Person> {
    const person = await signUp(`${role}@example.invalid`);
    await db.insert(member).values({
      id: `cohort-${role}`,
      organizationId: created.id,
      userId: person.user.id,
      role,
    });
    return { headers: person.headers, organizationId: created.id };
  }

  return {
    owner: { headers: owner.headers, organizationId: created.id },
    coordinator: await addMember("coordinator"),
    volunteer: await addMember("volunteer"),
    "report-reader": await addMember("report-reader"),
  };
}

async function allowed(
  person: Person,
  permissions: Record<string, string[]>,
): Promise<boolean> {
  const result = await auth.api.hasPermission({
    body: { organizationId: person.organizationId, permissions },
    headers: person.headers,
  });
  return result.success;
}

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  auth = createAuth({
    db,
    secret: "integration-test-secret-".padEnd(40, "x"),
    baseURL: "http://127.0.0.1:3101",
  });
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await resetAuthTables(db);
});

describe("custom app permissions per contract role", () => {
  it("expresses the approved matrix through the auth plugin", async () => {
    const {
      owner,
      coordinator,
      volunteer,
      "report-reader": reader,
    } = await seedRoleRoster();

    const domainPermissions = {
      source: ["submit"],
      review: ["write"],
      need: ["manage"],
      report: ["read"],
    };
    const reporting = { report: ["read"] };
    const submission = { source: ["submit"] };

    // Owner and coordinator hold the full operational set.
    for (const person of [owner, coordinator]) {
      expect(await allowed(person, domainPermissions)).toBe(true);
      expect(await allowed(person, submission)).toBe(true);
      expect(await allowed(person, reporting)).toBe(true);
    }

    // Volunteer may submit sources only.
    expect(await allowed(volunteer, submission)).toBe(true);
    expect(await allowed(volunteer, { review: ["write"] })).toBe(false);
    expect(await allowed(volunteer, { need: ["manage"] })).toBe(false);
    expect(await allowed(volunteer, reporting)).toBe(false);

    // Report reader may read aggregates only.
    expect(await allowed(reader, reporting)).toBe(true);
    expect(await allowed(reader, submission)).toBe(false);
    expect(await allowed(reader, { review: ["write"] })).toBe(false);
    expect(await allowed(reader, { need: ["manage"] })).toBe(false);
  });

  it("keeps organization administration owner-only", async () => {
    const people = await seedRoleRoster();

    // Owner administers members, invitations and organization settings.
    expect(
      await allowed(people.owner, {
        organization: ["update", "delete"],
        member: ["create", "update", "delete"],
        invitation: ["create", "cancel"],
      }),
    ).toBe(true);

    // Every administration action is denied to the other three roles; the
    // domain permissions never widen into member/invitation/organization control.
    const administration = [
      { organization: ["update"] },
      { organization: ["delete"] },
      { member: ["create"] },
      { member: ["update"] },
      { member: ["delete"] },
      { invitation: ["create"] },
      { invitation: ["cancel"] },
    ];

    for (const role of ["coordinator", "volunteer", "report-reader"] as const) {
      const person = people[role];
      for (const permissions of administration)
        expect(
          await allowed(person, permissions),
          `${role} must not hold ${JSON.stringify(permissions)}`,
        ).toBe(false);

      // The domain permissions do not leak into administration endpoints.
      await expectForbidden(
        auth.api.createInvitation({
          body: {
            email: `invited-${role}@example.invalid`,
            role: "volunteer",
            organizationId: person.organizationId,
          },
          headers: person.headers,
        }),
        "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
      );
      await expectForbidden(
        auth.api.updateOrganization({
          body: {
            organizationId: person.organizationId,
            data: { name: `Renamed by ${role}` },
          },
          headers: person.headers,
        }),
        "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION",
      );
    }

    expect(await countRows(db, "invitation")).toBe(0);
    const [stored] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, people.owner.organizationId));
    expect(stored?.name).toBe("Role Boundary Cohort");
  });

  it("still lets the owner administer and keeps the roster within the contract", async () => {
    const people = await seedRoleRoster();

    await auth.api.createInvitation({
      body: {
        email: "approved@example.invalid",
        role: "coordinator",
        organizationId: people.owner.organizationId,
      },
      headers: people.owner.headers,
    });
    await auth.api.updateOrganization({
      body: {
        organizationId: people.owner.organizationId,
        data: { name: "Role Boundary Cohort Renamed" },
      },
      headers: people.owner.headers,
    });

    expect(await countRows(db, "invitation")).toBe(1);
    const [stored] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, people.owner.organizationId));
    expect(stored?.name).toBe("Role Boundary Cohort Renamed");

    const roles = await db.execute(
      sql`select distinct role from member order by role`,
    );
    expect(
      (roles.rows as Array<{ role: string }>).map((row) => row.role),
    ).toEqual(["coordinator", "owner", "report-reader", "volunteer"]);
  });
});
