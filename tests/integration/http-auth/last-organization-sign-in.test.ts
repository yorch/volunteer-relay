import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Auth,
  createAuth,
  createRecordingMailer,
  createSessionResolver,
  createTenantAuthorization,
} from "../../../apps/web/lib/auth/index.ts";
import { createAuthHttpHandlers } from "../../../apps/web/lib/auth-http/index.ts";
import {
  createMembershipReader,
  type Database,
  eq,
  schema,
  seedOrganizations,
  sql,
} from "../../../packages/db/src/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

// Requires TEST_DATABASE_URL naming a private *_test database. Exercises the
// real Better Auth session creation and the HTTP handlers, without a server.
const {
  invitation,
  member,
  organization,
  session,
  user,
  userLastOrganization,
} = schema;
const appUrl = "http://localhost:3186";
const password = "synthetic-password-1";

let db: Database;
let close: () => Promise<void>;
let auth: Auth;
let handlers: ReturnType<typeof createAuthHttpHandlers>;

function cookieFrom(response: Response): Headers {
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

function post(path: string, body: unknown, cookie?: Headers) {
  return new Request(`${appUrl}/api/auth/${path}`, {
    method: "POST",
    headers: {
      origin: appUrl,
      "content-type": "application/json",
      ...(cookie ? { cookie: cookie.get("cookie") ?? "" } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function signUp(email: string) {
  const created = await auth.api.signUpEmail({
    body: { email, password, name: "Synthetic Person" },
  });
  return created.user.id;
}

// A fresh credential sign-in stands in for a new device: no prior cookie.
async function signIn(email: string): Promise<Headers> {
  const response = await handlers.signIn(post("sign-in", { email, password }));
  expect(response.status).toBe(200);
  return cookieFrom(response);
}

async function choices(cookie: Headers) {
  const response = await handlers.organizations(
    new Request(`${appUrl}/api/auth/organizations`, {
      headers: { cookie: cookie.get("cookie") ?? "" },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ok: true;
    value: {
      options: { organizationId: string }[];
      currentOrganizationId: string | null;
    };
  };
  return body.value;
}

async function select(cookie: Headers, organizationId: string) {
  return handlers.selectOrganization(
    post("organization", { organizationId }, cookie),
  );
}

async function join(userId: string, organizationId: string) {
  await db
    .insert(organization)
    .values({ id: organizationId, name: organizationId, slug: organizationId })
    .onConflictDoNothing();
  await db.insert(member).values({
    id: `${organizationId}-${userId}`,
    organizationId,
    userId,
    role: "volunteer",
  });
}

async function hint(userId: string) {
  const [row] = await db
    .select()
    .from(userLastOrganization)
    .where(eq(userLastOrganization.userId, userId));
  return row?.organizationId ?? null;
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
  auth = createAuth({
    db,
    secret: "integration-test-secret-".padEnd(40, "x"),
    baseURL: appUrl,
    mail: createRecordingMailer(),
  });
  const memberships = createMembershipReader(db);
  handlers = createAuthHttpHandlers({
    appUrl,
    auth,
    sessions: createSessionResolver({
      auth,
      authorization: createTenantAuthorization({ db }),
      memberships,
      appUrl,
      mailConfigured: true,
    }),
  });
});

describe("last-used organization at sign-in", () => {
  it("starts a new session in the organization the user last selected", async () => {
    const email = "hint-multi@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    await join(userId, "harbor");

    const first = await signIn(email);
    // No hint yet: a multi-organization user gets the picker.
    expect((await choices(first)).currentOrganizationId).toBeNull();
    expect((await select(first, "harbor")).status).toBe(200);
    expect(await hint(userId)).toBe("harbor");

    expect((await handlers.signOut(post("sign-out", {}, first))).status).toBe(
      200,
    );
    const second = await signIn(email);
    expect((await choices(second)).currentOrganizationId).toBe("harbor");
  });

  it("falls back to the picker and clears the hint once membership is gone", async () => {
    const email = "hint-removed@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    await join(userId, "harbor");
    await join(userId, "harbor-two");
    const first = await signIn(email);
    expect((await select(first, "harbor")).status).toBe(200);

    // The membership foreign key removes the hint with the membership.
    await db.delete(member).where(eq(member.id, `harbor-${userId}`));
    expect(await hint(userId)).toBeNull();
    const second = await signIn(email);
    expect((await choices(second)).currentOrganizationId).toBeNull();
  });

  it("ignores and clears a forged hint without live membership", async () => {
    const email = "hint-forged@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    await join(userId, "harbor-two");
    // Bypass the membership foreign key, as a corrupted or forged row would.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(
        sql`insert into user_last_organization (user_id, organization_id) values (${userId}, 'harbor')`,
      );
    });
    expect(await hint(userId)).toBe("harbor");

    const cookie = await signIn(email);
    const current = await choices(cookie);
    expect(current.currentOrganizationId).toBeNull();
    expect(current.options.map((o) => o.organizationId)).not.toContain(
      "harbor",
    );
    const [stored] = await db
      .select({ activeOrganizationId: session.activeOrganizationId })
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(sql`${session.createdAt} desc`)
      .limit(1);
    expect(stored?.activeOrganizationId ?? null).toBeNull();
    expect(await hint(userId)).toBeNull();
  });

  it("leaves a single-organization user unaffected", async () => {
    const email = "hint-single@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    const cookie = await signIn(email);
    const current = await choices(cookie);
    expect(current.options.map((o) => o.organizationId)).toEqual(["tidepath"]);
    // No selection is invented; the product resolver auto-selects one option.
    expect(current.currentOrganizationId).toBeNull();
    expect(await hint(userId)).toBeNull();
  });

  it("refuses to record a selection outside the user's memberships", async () => {
    const email = "hint-foreign@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    const cookie = await signIn(email);
    expect((await select(cookie, "harbor")).status).not.toBe(200);
    expect(await hint(userId)).toBeNull();
  });

  it("keeps one consistent hint under concurrent switches", async () => {
    const email = "hint-race@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    await join(userId, "harbor");
    const cookie = await signIn(email);
    const results = await Promise.all(
      ["tidepath", "harbor", "tidepath", "harbor"].map((id) =>
        select(cookie, id),
      ),
    );
    for (const result of results) expect(result.status).toBe(200);
    const stored = await hint(userId);
    expect(["tidepath", "harbor"]).toContain(stored);
    const rows = await db
      .select()
      .from(userLastOrganization)
      .where(eq(userLastOrganization.userId, userId));
    expect(rows).toHaveLength(1);
    expect((await choices(await signIn(email))).currentOrganizationId).toBe(
      stored,
    );
  });

  it("records the invited organization as last used on acceptance", async () => {
    const email = "hint-invitee@example.invalid";
    const userId = await signUp(email);
    await join(userId, "tidepath");
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, userId));
    await db.insert(invitation).values({
      id: "hint-invitation",
      organizationId: "harbor",
      email,
      role: "volunteer",
      status: "pending",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      inviterId: "user-rae",
    });
    const cookie = await signIn(email);
    const accepted = await handlers.acceptInvitation(
      post("invitation", { invitationId: "hint-invitation" }, cookie),
    );
    expect(accepted.status).toBe(200);
    expect(await hint(userId)).toBe("harbor");
    expect((await choices(await signIn(email))).currentOrganizationId).toBe(
      "harbor",
    );
  });
});
