import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Auth,
  createAuth,
  createRecordingMailer,
  createSessionResolver,
} from "../../../apps/web/lib/auth/index.ts";
import {
  createMembershipReader,
  type Database,
  schema,
  seedOrganizations,
  sql,
} from "../../../packages/db/src/index.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import { openTestDatabase, resetAuthTables } from "./support.ts";

const { member, session } = schema;
const appUrl = "http://127.0.0.1:3101";
const password = "synthetic-password-1";

let db: Database;
let close: () => Promise<void>;
let auth: Auth;
let memberships: ReturnType<typeof createMembershipReader>;

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

function resolver(options: { mailConfigured?: boolean } = {}) {
  return createSessionResolver({
    auth,
    authorization: createAuthorizationService({ memberships }),
    memberships,
    db,
    appUrl,
    mailConfigured: options.mailConfigured ?? true,
  });
}

async function addMembership(input: {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
}) {
  await db.insert(member).values(input);
}

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  memberships = createMembershipReader(db);
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
});

describe("verified-session tenant resolution", () => {
  it("requires a verified session and an explicit organization", async () => {
    const anonymous = await resolver().resolveVerifiedContext({
      headers: new Headers(),
      organizationId: "tidepath",
      correlationId: "corr-anon",
    });
    expect(anonymous.ok).toBe(false);
    if (anonymous.ok) throw new Error("expected failure");
    expect(anonymous.error.code).toBe("UNAUTHENTICATED");

    const person = await signUp("resolver-mira@example.invalid");
    const noOrganization = await resolver().resolveVerifiedContext({
      headers: person.headers,
      organizationId: null,
      correlationId: "corr-no-org",
    });
    expect(noOrganization.ok).toBe(false);
    if (noOrganization.ok) throw new Error("expected failure");
    expect(noOrganization.error.code).toBe("VALIDATION");
  });

  it("resolves a live membership and conceals non-membership", async () => {
    const person = await signUp("resolver-mira@example.invalid");
    await addMembership({
      id: "tidepath-mira-new",
      organizationId: "tidepath",
      userId: person.user.id,
      role: "volunteer",
    });

    const memberResult = await resolver().resolveVerifiedContext({
      headers: person.headers,
      organizationId: "tidepath",
      correlationId: "corr-member",
    });
    expect(memberResult).toMatchObject({
      ok: true,
      value: {
        organizationId: "tidepath",
        actor: { kind: "user", role: "volunteer" },
      },
    });

    const foreign = await resolver().resolveVerifiedContext({
      headers: person.headers,
      organizationId: "harbor",
      correlationId: "corr-foreign",
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) throw new Error("expected failure");
    expect(foreign.error.code).toBe("NOT_FOUND");
  });

  it("never treats activeOrganizationId as authority", async () => {
    const person = await signUp("resolver-nico@example.invalid");
    await addMembership({
      id: "tidepath-nico",
      organizationId: "tidepath",
      userId: person.user.id,
      role: "volunteer",
    });
    // Spoof the session's active organization to a tenant with no membership.
    await db.execute(
      sql`update "session" set active_organization_id = 'harbor' where user_id = ${person.user.id}`,
    );

    const result = await resolver().resolveVerifiedContext({
      headers: person.headers,
      organizationId: "harbor",
      correlationId: "corr-spoof",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.code).toBe("NOT_FOUND");
  });

  it("applies revocation and role downgrade immediately", async () => {
    const person = await signUp("resolver-sol@example.invalid");
    await addMembership({
      id: "tidepath-sol-new",
      organizationId: "tidepath",
      userId: person.user.id,
      role: "coordinator",
    });
    const resolved = await resolver().resolveVerifiedContext({
      headers: person.headers,
      organizationId: "tidepath",
      correlationId: "corr-role",
    });
    if (!resolved.ok) throw new Error("expected context");

    await db.execute(
      sql`update member set role = 'volunteer' where id = 'tidepath-sol-new'`,
    );
    const authorization = createAuthorizationService({ memberships });
    expect(
      (await authorization.require(resolved.value, "review:write")).ok,
    ).toBe(false);
    expect(
      (await authorization.require(resolved.value, "source:submit")).ok,
    ).toBe(true);

    await db.execute(sql`delete from member where id = 'tidepath-sol-new'`);
    const revoked = await resolver().resolveVerifiedContext({
      headers: person.headers,
      organizationId: "tidepath",
      correlationId: "corr-revoked",
    });
    expect(revoked.ok).toBe(false);
    if (revoked.ok) throw new Error("expected failure");
    expect(revoked.error.code).toBe("NOT_FOUND");
  });
});

describe("organization switching", () => {
  it("lists only live memberships and switches only to them", async () => {
    const person = await signUp("resolver-rae@example.invalid");
    await addMembership({
      id: "tidepath-rae-new",
      organizationId: "tidepath",
      userId: person.user.id,
      role: "owner",
    });
    await addMembership({
      id: "harbor-rae-new",
      organizationId: "harbor",
      userId: person.user.id,
      role: "report-reader",
    });

    const available = await resolver().listAvailableOrganizations({
      headers: person.headers,
      correlationId: "corr-list",
    });
    if (!available.ok) throw new Error("expected organizations");
    expect(available.value.map((row) => row.organizationId).sort()).toEqual([
      "harbor",
      "tidepath",
    ]);
    expect(
      available.value.find((row) => row.organizationId === "harbor")?.role,
    ).toBe("report-reader");

    // A foreign tenant is refused and the stored selection is unchanged.
    await resolver().switchOrganization({
      headers: person.headers,
      organizationId: "tidepath",
      correlationId: "corr-switch-own",
    });
    const foreign = await resolver().switchOrganization({
      headers: person.headers,
      organizationId: "missing-tenant",
      correlationId: "corr-switch-foreign",
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) throw new Error("expected failure");
    expect(foreign.error.code).toBe("NOT_FOUND");

    const [row] = await db
      .select({ active: session.activeOrganizationId })
      .from(session)
      .where(sql`${session.userId} = ${person.user.id}`);
    expect(row?.active).toBe("tidepath");
  });

  it("signs out of every session and refuses a foreign reset redirect", async () => {
    const person = await signUp("resolver-luz@example.invalid");
    const resetMail = createRecordingMailer();
    auth = createAuth({
      db,
      secret: "integration-test-secret-".padEnd(40, "x"),
      baseURL: appUrl,
      mail: resetMail,
    });
    const reset = await resolver().requestPasswordReset({
      headers: person.headers,
      email: "resolver-luz@example.invalid",
      redirectTo: "https://evil.example/reset",
      correlationId: "corr-reset",
    });
    expect(reset).toMatchObject({ ok: true, value: { accepted: true } });

    // The foreign origin never reaches the generated reset URL.
    expect(resetMail.resetMessages).toHaveLength(1);
    const resetUrl = resetMail.resetMessages[0]?.resetUrl ?? "";
    expect(resetUrl).toContain("/reset-password/");
    expect(resetUrl).not.toContain("evil.example");

    const withoutMail = await resolver({
      mailConfigured: false,
    }).requestPasswordReset({
      email: "resolver-luz@example.invalid",
      correlationId: "corr-no-mail",
    });
    expect(withoutMail.ok).toBe(false);
    if (withoutMail.ok) throw new Error("expected failure");
    expect(withoutMail.error.code).toBe("DEPENDENCY_UNAVAILABLE");

    await resolver().signOutEverywhere({
      headers: person.headers,
      correlationId: "corr-signout",
    });
    expect(await auth.api.getSession({ headers: person.headers })).toBeNull();
  });
});
