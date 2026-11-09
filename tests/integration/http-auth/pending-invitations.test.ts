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
} from "../../../packages/db/src/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

// Requires TEST_DATABASE_URL naming a private *_test database. Real Better Auth
// sessions and invitation rows through the HTTP handlers, without a server.
const { invitation, member, organization, user } = schema;
const appUrl = "http://localhost:3186";
const password = "synthetic-password-1";
const hour = 60 * 60 * 1000;

let db: Database;
let close: () => Promise<void>;
let auth: Auth;
let handlers: ReturnType<typeof createAuthHttpHandlers>;

function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function signUpAndSignIn(email: string, verified: boolean) {
  const created = await auth.api.signUpEmail({
    body: { email, password, name: "Synthetic Person" },
  });
  if (verified)
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, created.user.id));
  const response = await handlers.signIn(
    new Request(`${appUrl}/api/auth/sign-in`, {
      method: "POST",
      headers: { origin: appUrl, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  return { userId: created.user.id, cookie: cookieFrom(response) };
}

async function list(cookie: string) {
  const response = await handlers.invitations(
    new Request(`${appUrl}/api/auth/invitations`, { headers: { cookie } }),
  );
  return { status: response.status, body: await response.json() };
}

async function invite(
  id: string,
  email: string,
  overrides: Partial<typeof invitation.$inferInsert> = {},
) {
  await db.insert(invitation).values({
    id,
    organizationId: "harbor",
    email,
    role: "volunteer",
    status: "pending",
    expiresAt: new Date(Date.now() + 24 * hour),
    inviterId: "user-rae",
    ...overrides,
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
  auth = createAuth({
    db,
    secret: "integration-test-secret-".padEnd(40, "x"),
    baseURL: appUrl,
    mail: createRecordingMailer(),
  });
  handlers = createAuthHttpHandlers({
    appUrl,
    auth,
    sessions: createSessionResolver({
      auth,
      authorization: createTenantAuthorization({ db }),
      memberships: createMembershipReader(db),
      appUrl,
      mailConfigured: true,
    }),
  });
});

describe("pending invitations for the signed-in recipient", () => {
  it("denies an anonymous request", async () => {
    const { status, body } = await list("");
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("lists nothing for an unverified email even when rows exist", async () => {
    const email = "unverified-invitee@example.invalid";
    const { cookie } = await signUpAndSignIn(email, false);
    await invite("unverified-invitation", email);
    expect(await list(cookie)).toEqual({
      status: 200,
      body: { ok: true, value: { emailVerified: false, invitations: [] } },
    });
  });

  it("lists only the recipient's pending, unexpired rows, and acceptance still decides", async () => {
    const email = "verified-invitee@example.invalid";
    const { userId, cookie } = await signUpAndSignIn(email, true);
    const soon = new Date(Date.now() + 2 * hour);
    const later = new Date(Date.now() + 30 * hour);
    await db
      .insert(organization)
      .values({ id: "lantern", name: "Lantern Pantry", slug: "lantern" });
    await invite("pending-later", email, {
      organizationId: "lantern",
      role: "coordinator",
      expiresAt: later,
    });
    await invite("pending-soon", email, { expiresAt: soon });
    await invite("expired", email, {
      expiresAt: new Date(Date.now() - hour),
    });
    await invite("accepted", email, { status: "accepted" });
    await invite("foreign", "someone-else@example.invalid");

    const { status, body } = await list(cookie);
    expect(status).toBe(200);
    const [harbor] = await db
      .select({ name: organization.name })
      .from(organization)
      .where(eq(organization.id, "harbor"));
    expect(body).toEqual({
      ok: true,
      value: {
        emailVerified: true,
        invitations: [
          {
            invitationId: "pending-soon",
            organizationName: harbor?.name,
            role: "volunteer",
            expiresAt: soon.toISOString(),
          },
          {
            invitationId: "pending-later",
            organizationName: "Lantern Pantry",
            role: "coordinator",
            expiresAt: later.toISOString(),
          },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/someone-else|user-rae|harbor"/);

    // A listed id is not authority over a foreign invitation.
    const foreign = await handlers.acceptInvitation(
      new Request(`${appUrl}/api/auth/invitations/accept`, {
        method: "POST",
        headers: {
          origin: appUrl,
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify({ invitationId: "foreign" }),
      }),
    );
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("NOT_AVAILABLE");

    const accepted = await handlers.acceptInvitation(
      new Request(`${appUrl}/api/auth/invitations/accept`, {
        method: "POST",
        headers: {
          origin: appUrl,
          "content-type": "application/json",
          cookie,
        },
        body: JSON.stringify({ invitationId: "pending-soon" }),
      }),
    );
    expect(accepted.status).toBe(200);
    const memberships = await db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, userId));
    expect(memberships).toEqual([{ organizationId: "harbor" }]);
    const after = await list(cookie);
    expect(
      after.body.value.invitations.map(
        (item: { invitationId: string }) => item.invitationId,
      ),
    ).toEqual(["pending-later"]);
  });
});
