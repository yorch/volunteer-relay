import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Auth, createAuth } from "../../../apps/web/lib/auth/auth.ts";
import {
  type Database,
  eq,
  schema,
  sql,
} from "../../../packages/db/src/index.ts";
import {
  countRows,
  expectDatabaseRejection,
  openTestDatabase,
  resetAuthTables,
} from "./support.ts";

const { account, invitation, member, session, user } = schema;

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

async function expectApiError(action: Promise<unknown>, code: string) {
  try {
    await action;
  } catch (error) {
    const body = (error as { body?: { code?: string } }).body;
    expect(body?.code).toBe(code);
    return;
  }
  throw new Error(`Expected API error ${code}, but the call succeeded`);
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

describe("Better Auth against the generated schema", () => {
  it("persists a credential sign-up with a hash, never a plaintext password", async () => {
    const { user: created } = await signUp("mira@example.invalid");
    expect(created.email).toBe("mira@example.invalid");

    const [storedUser] = await db
      .select()
      .from(user)
      .where(eq(user.id, created.id));
    expect(storedUser?.email).toBe("mira@example.invalid");
    expect(storedUser?.emailVerified).toBe(false);

    const [storedAccount] = await db
      .select()
      .from(account)
      .where(eq(account.userId, created.id));
    expect(storedAccount?.providerId).toBe("credential");
    expect(storedAccount?.password).toBeTruthy();
    expect(storedAccount?.password).not.toBe(password);
    expect(storedAccount?.password).toContain(":");
    expect(await countRows(db, "session")).toBe(1);
  });

  it("reads the session back through the adapter", async () => {
    const { headers, user: created } = await signUp("sol@example.invalid");

    const [storedSession] = await db
      .select()
      .from(session)
      .where(eq(session.userId, created.id));
    expect(storedSession?.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const read = await auth.api.getSession({ headers });
    expect(read?.user.id).toBe(created.id);
    expect(read?.user.email).toBe("sol@example.invalid");
  });

  it("creates a tenant with an owner membership the schema constraint accepts", async () => {
    const { headers } = await signUp("owner@example.invalid");

    const created = await auth.api.createOrganization({
      body: { name: "Synthetic Tidepath", slug: "synthetic-tidepath" },
      headers,
    });
    if (!created) throw new Error("expected an organization");

    const [membership] = await db
      .select()
      .from(member)
      .where(eq(member.organizationId, created.id));
    expect(membership?.role).toBe("owner");
  });

  it("invites with an explicit contract role and refuses an out-of-contract default", async () => {
    const { headers } = await signUp("inviter@example.invalid");
    const created = await auth.api.createOrganization({
      body: { name: "Synthetic Harbor", slug: "synthetic-harbor" },
      headers,
    });
    if (!created) throw new Error("expected an organization");

    await auth.api.createInvitation({
      body: {
        email: "invitee@example.invalid",
        role: "coordinator",
        organizationId: created.id,
      },
      headers,
    });
    const [storedInvitation] = await db
      .select()
      .from(invitation)
      .where(eq(invitation.organizationId, created.id));
    expect(storedInvitation?.role).toBe("coordinator");
    expect(storedInvitation?.status).toBe("pending");

    // The plugin's own default role "member" is outside the contract. The
    // request type no longer offers it, and forcing the string through is
    // stopped by the database check constraint rather than stored.
    const outOfContractRole = "member" as unknown as "volunteer";
    await expectDatabaseRejection(
      () =>
        auth.api.createInvitation({
          body: {
            email: "default@example.invalid",
            role: outOfContractRole,
            organizationId: created.id,
          },
          headers,
        }),
      "23514",
    );
    expect(await countRows(db, "invitation")).toBe(1);
  });

  it("denies tenant administration to a volunteer", async () => {
    const { headers: ownerHeaders } = await signUp("owner2@example.invalid");
    const created = await auth.api.createOrganization({
      body: { name: "Synthetic Riverbend", slug: "synthetic-riverbend" },
      headers: ownerHeaders,
    });
    if (!created) throw new Error("expected an organization");

    const volunteer = await signUp("volunteer@example.invalid");
    await db.execute(
      sql`insert into member (id, organization_id, user_id, role) values ('invite-volunteer', ${created.id}, ${volunteer.user.id}, 'volunteer')`,
    );

    await expectApiError(
      auth.api.createInvitation({
        body: {
          email: "other@example.invalid",
          role: "volunteer",
          organizationId: created.id,
        },
        headers: volunteer.headers,
      }),
      "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
    );
  });
});
