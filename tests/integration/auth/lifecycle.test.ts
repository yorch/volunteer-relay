import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Auth,
  createAuth,
  createRecordingMailer,
  createSessionResolver,
  type RecordingMailer,
} from "../../../apps/web/lib/auth/index.ts";
import {
  createMembershipReader,
  type Database,
  eq,
  schema,
  sql,
} from "../../../packages/db/src/index.ts";
import {
  createAuthorizationService,
  validateInvitationCommand,
} from "../../../packages/domain/auth/src/index.ts";
import { countRows, openTestDatabase, resetAuthTables } from "./support.ts";

const { member, session } = schema;

let db: Database;
let close: () => Promise<void>;
let auth: Auth;
let mail: RecordingMailer;

const password = "synthetic-password-1";
const appUrl = "http://127.0.0.1:3101";

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

async function createOrganizationFor(email: string, slug: string) {
  const person = await signUp(email);
  const organization = await auth.api.createOrganization({
    body: { name: `Org ${slug}`, slug },
    headers: person.headers,
  });
  if (!organization) throw new Error("expected organization");
  return { person, organization };
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
  mail = createRecordingMailer();
  auth = createAuth({
    db,
    secret: "integration-test-secret-".padEnd(40, "x"),
    baseURL: appUrl,
    mail,
  });
});

describe("session lifecycle", () => {
  it("issues, verifies, revokes and invalidates sessions", async () => {
    const person = await signUp("mira@example.invalid");

    const live = await auth.api.getSession({ headers: person.headers });
    expect(live?.user.email).toBe("mira@example.invalid");

    // Absent and malformed cookies read as no session.
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({
          cookie: "better-auth.session_token=not-a-token",
        }),
      }),
    ).toBeNull();

    const [sessionRow] = await db
      .select()
      .from(session)
      .where(eq(session.userId, person.user.id));
    await auth.api.revokeSession({
      body: { token: sessionRow?.token ?? "" },
      headers: person.headers,
    });
    expect(await auth.api.getSession({ headers: person.headers })).toBeNull();
  });

  it("expires a stored session and revokes every session at once", async () => {
    const first = await signUp("sol@example.invalid");
    await auth.api.signInEmail({
      body: { email: "sol@example.invalid", password },
      returnHeaders: true,
    });
    expect(await countRows(db, "session")).toBe(2);

    await auth.api.revokeSessions({ headers: first.headers });
    expect(await countRows(db, "session")).toBe(0);
    expect(await auth.api.getSession({ headers: first.headers })).toBeNull();

    const expiredPerson = await signUp("luz@example.invalid");
    await db.execute(
      sql`update "session" set expires_at = now() - interval '1 hour' where user_id = ${expiredPerson.user.id}`,
    );
    expect(
      await auth.api.getSession({ headers: expiredPerson.headers }),
    ).toBeNull();
    expect(await countRows(db, "user")).toBe(2);
  });
});

describe("password reset lifecycle", () => {
  it("captures a single-use token and refuses reuse or expiry", async () => {
    await signUp("mira@example.invalid");

    await auth.api.requestPasswordReset({
      body: { email: "mira@example.invalid" },
    });
    expect(mail.resetMessages).toHaveLength(1);
    const token = mail.resetMessages[0]?.token ?? "";
    expect(token.length).toBeGreaterThan(0);

    await auth.api.resetPassword({
      body: { newPassword: "synthetic-password-2", token },
    });
    // Reuse of the consumed token fails.
    await expect(
      auth.api.resetPassword({
        body: { newPassword: "synthetic-password-3", token },
      }),
    ).rejects.toThrow();

    // An expired token fails even if never used.
    await auth.api.requestPasswordReset({
      body: { email: "mira@example.invalid" },
    });
    const expiredToken = mail.resetMessages[1]?.token ?? "";
    await db.execute(
      sql`update "verification" set expires_at = now() - interval '1 hour' where identifier = ${`reset-password:${expiredToken}`}`,
    );
    await expect(
      auth.api.resetPassword({
        body: { newPassword: "synthetic-password-4", token: expiredToken },
      }),
    ).rejects.toThrow();
    expect(await countRows(db, "verification")).toBe(0);
  });

  it("revokes all sessions on the direct library reset path", async () => {
    const first = await signUp("direct-reset@example.invalid");
    const second = await auth.api.signInEmail({
      body: { email: first.user.email, password },
      returnHeaders: true,
    });
    expect(await countRows(db, "session")).toBe(2);
    await auth.api.requestPasswordReset({ body: { email: first.user.email } });
    await auth.api.resetPassword({
      body: {
        token: mail.resetMessages[0]?.token ?? "",
        newPassword: "synthetic-password-new",
      },
    });
    expect(await countRows(db, "session")).toBe(0);
    expect(await auth.api.getSession({ headers: first.headers })).toBeNull();
    expect(
      await auth.api.getSession({
        headers: cookieHeaders(second.headers.get("set-cookie")),
      }),
    ).toBeNull();
    await expect(
      auth.api.signInEmail({ body: { email: first.user.email, password } }),
    ).rejects.toThrow();
    expect(
      await auth.api.signInEmail({
        body: { email: first.user.email, password: "synthetic-password-new" },
      }),
    ).toMatchObject({ user: { id: first.user.id } });
  });

  it.each(["direct", "helper"])(
    "rolls back token, password and sessions when %s reset revocation fails",
    async (path) => {
      const person = await signUp("rollback@example.invalid");
      await auth.api.requestPasswordReset({
        body: { email: person.user.email },
      });
      const token = mail.resetMessages[0]?.token ?? "";
      const before = await db.execute(
        sql`select password from account where user_id = ${person.user.id}`,
      );
      // Test-private fault injection, removed before any subsequent suite reset.
      await db.execute(
        sql`create function b_test_fail_reset_revocation() returns trigger language plpgsql as $$ begin raise exception 'synthetic revocation failure'; end $$`,
      );
      await db.execute(
        sql`create trigger fail_reset_revocation before delete on "session" for each row execute function b_test_fail_reset_revocation()`,
      );
      try {
        const input = {
          token,
          newPassword: "synthetic-password-new",
          correlationId: "corr-rollback",
        };
        if (path === "direct") {
          await expect(
            auth.api.resetPassword({ body: input }),
          ).rejects.toThrow();
        } else {
          const result = await createSessionResolver({
            auth,
            authorization: createAuthorizationService({
              memberships: createMembershipReader(db),
            }),
            memberships: createMembershipReader(db),
            appUrl,
            mailConfigured: true,
          }).resetPassword(input);
          expect(result).toMatchObject({
            ok: false,
            error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
          });
          expect(JSON.stringify(result)).not.toContain(
            "synthetic revocation failure",
          );
          expect(JSON.stringify(result)).not.toContain(token);
        }
        expect(await countRows(db, "session")).toBe(1);
        expect(
          await auth.api.getSession({ headers: person.headers }),
        ).not.toBeNull();
        expect(
          await db.execute(
            sql`select password from account where user_id = ${person.user.id}`,
          ),
        ).toMatchObject({ rows: before.rows });
        expect(await countRows(db, "verification")).toBe(1);
      } finally {
        await db.execute(sql`drop trigger fail_reset_revocation on "session"`);
        await db.execute(sql`drop function b_test_fail_reset_revocation()`);
      }
      // The same token remains usable after the failed transaction.
      await auth.api.resetPassword({
        body: { token, newPassword: "synthetic-password-retry" },
      });
      expect(await countRows(db, "verification")).toBe(0);
      expect(await countRows(db, "session")).toBe(0);
    },
  );

  it("does not enumerate unknown accounts", async () => {
    await signUp("mira@example.invalid");
    const known = await auth.api.requestPasswordReset({
      body: { email: "mira@example.invalid" },
    });
    const unknown = await auth.api.requestPasswordReset({
      body: { email: "nobody@example.invalid" },
    });
    expect(unknown).toEqual(known);
    expect(mail.resetMessages).toHaveLength(1);
  });

  it("keeps transport failures bounded and non-enumerating", async () => {
    auth = createAuth({
      db,
      secret: "integration-test-secret-".padEnd(40, "x"),
      baseURL: appUrl,
      mail: createRecordingMailer({ failReset: true }),
    });
    await signUp("sol@example.invalid");
    const response = await auth.api.requestPasswordReset({
      body: { email: "sol@example.invalid" },
    });
    // The endpoint stays non-enumerating; the pending token remains for retry.
    expect(response).toMatchObject({ status: true });
    expect(await countRows(db, "verification")).toBe(1);
    expect(JSON.stringify(response)).not.toContain("transport");
  });
});

describe("invitation lifecycle and role validation", () => {
  it("invites each canonical role and rejects everything else", async () => {
    const { person: owner, organization } = await createOrganizationFor(
      "owner@example.invalid",
      "invite-roles",
    );

    for (const role of ["coordinator", "volunteer", "report-reader"] as const) {
      await auth.api.createInvitation({
        body: {
          email: `${role}@example.invalid`,
          role,
          organizationId: organization.id,
        },
        headers: owner.headers,
      });
    }
    expect(mail.invitationMessages.map((m) => m.role).sort()).toEqual([
      "coordinator",
      "report-reader",
      "volunteer",
    ]);
    expect(mail.invitationMessages[0]?.acceptPath).toMatch(/^\/invitations\//);

    // Domain validation rejects aliases, multi-role strings and padding.
    for (const role of ["member", "admin", "owner,coordinator", " volunteer"]) {
      const validated = validateInvitationCommand({
        email: "someone@example.invalid",
        role,
        organizationId: organization.id,
      });
      expect(validated.ok).toBe(false);
    }
    const valid = validateInvitationCommand({
      email: "someone@example.invalid",
      role: "coordinator",
      organizationId: organization.id,
    });
    expect(valid).toMatchObject({ ok: true, value: { role: "coordinator" } });
  });

  it("accepts an invitation once, for the right recipient only", async () => {
    const { person: owner, organization } = await createOrganizationFor(
      "owner@example.invalid",
      "invite-accept",
    );
    await auth.api.createInvitation({
      body: {
        email: "invitee@example.invalid",
        role: "coordinator",
        organizationId: organization.id,
      },
      headers: owner.headers,
    });
    const invitationId = mail.invitationMessages[0]?.invitationId ?? "";

    // Wrong recipient cannot accept.
    const wrong = await signUp("other@example.invalid");
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId },
        headers: wrong.headers,
      }),
    ).rejects.toThrow();
    expect(
      await db.select().from(member).where(eq(member.userId, wrong.user.id)),
    ).toHaveLength(0);

    const invitee = await signUp("invitee@example.invalid");

    // A merely self-declared (unverified) email cannot accept the invitation.
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId },
        headers: invitee.headers,
      }),
    ).rejects.toThrow();

    // Verified recipient accepts the emailed secret exactly once.
    await db.execute(
      sql`update "user" set email_verified = true where id = ${invitee.user.id}`,
    );
    await auth.api.acceptInvitation({
      body: { invitationId },
      headers: invitee.headers,
    });
    const [membership] = await db
      .select()
      .from(member)
      .where(eq(member.userId, invitee.user.id));
    expect(membership?.role).toBe("coordinator");
    expect(membership?.organizationId).toBe(organization.id);

    // Replaying the accepted invitation fails and adds no membership.
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId },
        headers: invitee.headers,
      }),
    ).rejects.toThrow();
    expect(await countRows(db, "member")).toBe(2);
  });

  it("refuses a canceled or expired invitation and volunteer administration", async () => {
    const { person: owner, organization } = await createOrganizationFor(
      "owner@example.invalid",
      "invite-cancel",
    );
    await auth.api.createInvitation({
      body: {
        email: "invitee@example.invalid",
        role: "volunteer",
        organizationId: organization.id,
      },
      headers: owner.headers,
    });
    const cancelId = mail.invitationMessages[0]?.invitationId ?? "";
    await auth.api.cancelInvitation({
      body: { invitationId: cancelId },
      headers: owner.headers,
    });
    const invitee = await signUp("invitee@example.invalid");
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId: cancelId },
        headers: invitee.headers,
      }),
    ).rejects.toThrow();

    // Expired invitation.
    await auth.api.createInvitation({
      body: {
        email: "late@example.invalid",
        role: "volunteer",
        organizationId: organization.id,
      },
      headers: owner.headers,
    });
    const expiredId = mail.invitationMessages[1]?.invitationId ?? "";
    await db.execute(
      sql`update "invitation" set expires_at = now() - interval '1 hour' where id = ${expiredId}`,
    );
    const late = await signUp("late@example.invalid");
    await db.execute(
      sql`update "user" set email_verified = true where id = ${late.user.id}`,
    );
    await expect(
      auth.api.acceptInvitation({
        body: { invitationId: expiredId },
        headers: late.headers,
      }),
    ).rejects.toThrow();

    // A volunteer cannot invite.
    const [volunteerMembership] = await db
      .select()
      .from(member)
      .where(eq(member.userId, invitee.user.id));
    expect(volunteerMembership).toBeUndefined();
    await db.insert(member).values({
      id: "cancel-volunteer",
      organizationId: organization.id,
      userId: invitee.user.id,
      role: "volunteer",
    });
    await expect(
      auth.api.createInvitation({
        body: {
          email: "someone@example.invalid",
          role: "volunteer",
          organizationId: organization.id,
        },
        headers: invitee.headers,
      }),
    ).rejects.toThrow();
    expect(await countRows(db, "invitation")).toBe(2);
  });
});

describe("settled lifecycle boundaries", () => {
  it("reports a bounded invitation delivery failure while keeping the invitation pending", async () => {
    const failures: Array<{ kind: "reset" | "invitation" }> = [];
    const recorder = createRecordingMailer({ failInvitation: true });
    const tracked = {
      mail: {
        sendPasswordReset: recorder.sendPasswordReset.bind(recorder),
        sendInvitation: recorder.sendInvitation.bind(recorder),
      },
      failures,
    };
    const trackedAuth = createAuth({
      db,
      secret: "integration-test-secret-".padEnd(40, "x"),
      baseURL: appUrl,
      mail: {
        async sendPasswordReset(message) {
          failures.push({ kind: "reset" });
          await tracked.mail.sendPasswordReset(message);
        },
        async sendInvitation(message) {
          failures.push({ kind: "invitation" });
          await tracked.mail.sendInvitation(message);
        },
      },
    });

    const owner = await trackedAuth.api.signUpEmail({
      body: {
        email: "boundary-owner@example.invalid",
        password,
        name: "Owner",
      },
      returnHeaders: true,
    });
    const ownerHeaders = cookieHeaders(owner.headers.get("set-cookie"));
    const organization = await trackedAuth.api.createOrganization({
      body: { name: "Boundary Org", slug: "boundary-org" },
      headers: ownerHeaders,
    });
    if (!organization) throw new Error("expected organization");

    // The invitation row is created even though delivery failed.
    await trackedAuth.api.createInvitation({
      body: {
        email: "boundary-invitee@example.invalid",
        role: "volunteer",
        organizationId: organization.id,
      },
      headers: ownerHeaders,
    });
    expect(failures.filter((f) => f.kind === "invitation")).toHaveLength(1);
    expect(await countRows(db, "invitation")).toBe(1);
    expect(JSON.stringify(failures)).not.toContain("boundary-invitee");
  });

  it("invalidates prior sessions when a password is reset", async () => {
    const person = await signUp("reset-session@example.invalid");
    expect(
      await auth.api.getSession({ headers: person.headers }),
    ).not.toBeNull();

    await auth.api.requestPasswordReset({
      body: { email: "reset-session@example.invalid" },
    });
    const token = mail.resetMessages[0]?.token ?? "";
    const resolver = createSessionResolver({
      auth,
      authorization: createAuthorizationService({
        memberships: createMembershipReader(db),
      }),
      memberships: createMembershipReader(db),
      appUrl,
      mailConfigured: true,
    });
    const reset = await resolver.resetPassword({
      token,
      newPassword: "synthetic-password-9",
      correlationId: "corr-reset-sessions",
    });
    expect(reset).toMatchObject({ ok: true, value: { reset: true } });

    // Every session issued before the reset is gone.
    expect(await countRows(db, "session")).toBe(0);
    expect(await auth.api.getSession({ headers: person.headers })).toBeNull();
  });

  it("refuses out-of-contract roles through the plugin before persistence", async () => {
    const { person: owner, organization } = await createOrganizationFor(
      "alias-owner@example.invalid",
      "alias-org",
    );
    const invitee = await signUp("alias-invitee@example.invalid");
    await db.execute(
      sql`update "user" set email_verified = true where id = ${invitee.user.id}`,
    );
    await db.insert(member).values({
      id: "alias-invitee-member",
      organizationId: organization.id,
      userId: invitee.user.id,
      role: "volunteer",
    });

    for (const role of ["member", "admin", "owner,coordinator"]) {
      await expect(
        auth.api.createInvitation({
          body: {
            email: "someone@example.invalid",
            role: role as "volunteer",
            organizationId: organization.id,
          },
          headers: owner.headers,
        }),
      ).rejects.toThrow();
      await expect(
        auth.api.updateMemberRole({
          body: {
            memberId: "alias-invitee-member",
            role: role as "volunteer",
            organizationId: organization.id,
          },
          headers: owner.headers,
        }),
      ).rejects.toThrow();
    }

    const [stored] = await db
      .select({ role: member.role })
      .from(member)
      .where(eq(member.id, "alias-invitee-member"));
    expect(stored?.role).toBe("volunteer");
    expect(await countRows(db, "invitation")).toBe(0);
  });
});
