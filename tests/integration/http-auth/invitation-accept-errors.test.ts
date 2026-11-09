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
import {
  countRows,
  openTestDatabase,
  resetAuthTables,
} from "../auth/support.ts";

// Requires TEST_DATABASE_URL naming a private *_test database. Real Better Auth
// sessions and invitation rows through the HTTP handlers, without a server.
// Acceptance failures distinguish only what the signed-in caller is entitled
// to know; everything else is one indistinguishable NOT_AVAILABLE response.
const { invitation, user } = schema;
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

async function signIn(email: string, verified: boolean) {
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
  return cookieFrom(response);
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

// Everything observable except the per-request correlation id.
async function accept(cookie: string, invitationId: string) {
  const response = await handlers.acceptInvitation(
    new Request(`${appUrl}/api/auth/invitations/accept`, {
      method: "POST",
      headers: { origin: appUrl, "content-type": "application/json", cookie },
      body: JSON.stringify({ invitationId }),
    }),
  );
  const text = await response.text();
  const parsed = JSON.parse(text);
  expect(parsed.error?.correlationId ?? "").toEqual(expect.any(String));
  return {
    status: response.status,
    body: text.replace(/"correlationId":"[^"]*"/, '"correlationId":"<id>"'),
    headers: [...response.headers.keys()].sort(),
    cacheControl: response.headers.get("cache-control"),
    code: parsed.error?.code as string | undefined,
  };
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

describe("invitation acceptance failures", () => {
  it("answers unknown, foreign-recipient, used and canceled ids with one identical response", async () => {
    const caller = await signIn("probe@example.invalid", true);
    await invite("foreign", "victim@example.invalid");
    await invite("foreign-expired", "victim@example.invalid", {
      expiresAt: new Date(Date.now() - hour),
    });
    await invite("used", "probe@example.invalid", { status: "accepted" });
    await invite("canceled", "probe@example.invalid", { status: "canceled" });
    const members = await countRows(db, "member");

    const missing = await accept(caller, "does-not-exist");
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("NOT_AVAILABLE");
    expect(missing.cacheControl).toBe("no-store");
    expect(JSON.parse(missing.body)).toEqual({
      ok: false,
      error: {
        code: "NOT_AVAILABLE",
        message: "Invitation is not available",
        correlationId: "<id>",
        retryable: false,
      },
    });
    for (const id of ["foreign", "foreign-expired", "used", "canceled"])
      expect(await accept(caller, id), id).toEqual(missing);
    expect(missing.body).not.toMatch(/victim|harbor|user-rae/);
    expect(await countRows(db, "member")).toBe(members);
  });

  it("reports expiry only to the verified recipient", async () => {
    const recipient = await signIn("late@example.invalid", true);
    const other = await signIn("other@example.invalid", true);
    await invite("expired", "late@example.invalid", {
      expiresAt: new Date(Date.now() - hour),
    });
    const members = await countRows(db, "member");

    const expired = await accept(recipient, "expired");
    expect(expired.status).toBe(410);
    expect(expired.code).toBe("INVITATION_EXPIRED");
    expect(expired.cacheControl).toBe("no-store");
    // Anyone else learns nothing: the same answer as a nonexistent id.
    expect(await accept(other, "expired")).toEqual(
      await accept(other, "does-not-exist"),
    );
    expect((await accept(other, "expired")).code).toBe("NOT_AVAILABLE");
    expect(await countRows(db, "member")).toBe(members);
  });

  it("asks an unverified recipient to verify, whatever the invitation id", async () => {
    const caller = await signIn("unverified@example.invalid", false);
    await invite("valid", "unverified@example.invalid");
    const members = await countRows(db, "member");

    const own = await accept(caller, "valid");
    expect(own.status).toBe(403);
    expect(own.code).toBe("EMAIL_NOT_VERIFIED");
    // Decided before any lookup, so it is not an invitation oracle either.
    expect(await accept(caller, "does-not-exist")).toEqual(own);
    expect(await countRows(db, "member")).toBe(members);

    // Once verified, the same invitation is accepted.
    await db
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.email, "unverified@example.invalid"));
    const accepted = await accept(caller, "valid");
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({ ok: true });
    expect(await countRows(db, "member")).toBe(members + 1);
    // Single use: a second attempt is not available.
    expect((await accept(caller, "valid")).code).toBe("NOT_AVAILABLE");
  });

  it("requires a session", async () => {
    await invite("valid", "nobody@example.invalid");
    const anonymous = await accept("", "valid");
    expect(anonymous.status).toBe(401);
    expect(anonymous.code).toBe("UNAUTHENTICATED");
  });
});
