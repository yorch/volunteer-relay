import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
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
  sql,
} from "../../../packages/db/src/index.ts";
import { createAuthorizationService } from "../../../packages/domain/auth/src/index.ts";
import { countRows, openTestDatabase, resetAuthTables } from "./support.ts";

const appUrl = "http://127.0.0.1:3171";
const password = "synthetic-verification-password";
let db: Database;
let close: () => Promise<void>;
let auth: Auth;
let mail: RecordingMailer;
function configure(configured = true, fail = false) {
  mail = createRecordingMailer({ failVerification: fail });
  auth = createAuth({
    db,
    secret: "synthetic-verification-secret".padEnd(40, "x"),
    baseURL: appUrl,
    ...(configured ? { mail } : {}),
  });
  const memberships = createMembershipReader(db);
  return createSessionResolver({
    auth,
    memberships,
    authorization: createAuthorizationService({ memberships }),
    appUrl,
    mailConfigured: configured,
  });
}
async function signup(email = "recipient@example.invalid") {
  return auth.api.signUpEmail({
    body: { email, password, name: "Synthetic Recipient" },
    returnHeaders: true,
  });
}
function headers(result: Awaited<ReturnType<typeof signup>>) {
  return new Headers({
    cookie: result.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
}
beforeAll(async () => {
  ({ db, close } = await openTestDatabase());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetAuthTables(db);
  configure();
});

it("verifies only the intended account once, without session or membership grants", async () => {
  const resolver = configure();
  const person = await signup();
  await signup("other@example.invalid");
  const responseHeaders = new Headers();
  expect(
    await resolver.requestEmailVerification({
      email: person.response.user.email,
      correlationId: "request",
      responseHeaders,
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(mail.verificationMessages).toHaveLength(1);
  const message = mail.verificationMessages[0];
  if (!message) throw new Error("expected synthetic mail");
  const url = new URL(message.verificationUrl);
  expect(url.origin).toBe(appUrl);
  expect(url.pathname).toBe("/verify-email");
  expect(url.searchParams.get("token")).toBe(message.token);
  expect(url.searchParams.has("callbackURL")).toBe(false);
  const stored = await db.execute(sql`select * from verification`);
  expect(JSON.stringify(stored.rows)).not.toContain(message.token);
  expect(
    await resolver.confirmEmailVerification({
      token: message.token,
      correlationId: "confirm",
      responseHeaders,
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(
    await resolver.confirmEmailVerification({
      token: message.token,
      correlationId: "replay",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(
    (
      await db.execute(
        sql`select email from "user" where email_verified = true`,
      )
    ).rows,
  ).toEqual([{ email: "recipient@example.invalid" }]);
  expect(await countRows(db, "member")).toBe(0);
  expect(await countRows(db, "session")).toBe(2);
  expect(responseHeaders.getSetCookie()).toEqual([]);
  expect(await countRows(db, "verification")).toBe(0);
});

it("serializes concurrent consumption to one success", async () => {
  const resolver = configure();
  await signup();
  await resolver.requestEmailVerification({
    email: "recipient@example.invalid",
    correlationId: "request",
  });
  const token = mail.verificationMessages[0]?.token ?? "";
  const results = await Promise.all(
    [1, 2].map((i) =>
      resolver.confirmEmailVerification({
        token,
        correlationId: `confirm-${i}`,
      }),
    ),
  );
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toHaveLength(1);
});

it("denies expired, altered, foreign URL, wrong binding and changed-email tokens", async () => {
  const resolver = configure();
  await signup();
  await resolver.requestEmailVerification({
    email: "recipient@example.invalid",
    correlationId: "request",
  });
  const token = mail.verificationMessages[0]?.token ?? "";
  for (const invalid of [
    "invalid",
    `${token}x`,
    `https://foreign.invalid/?token=${token}`,
  ]) {
    expect(
      await resolver.confirmEmailVerification({
        token: invalid,
        correlationId: "invalid",
      }),
    ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  }
  await db.execute(
    sql`update verification set expires_at = now() - interval '1 second'`,
  );
  expect(
    await resolver.confirmEmailVerification({
      token,
      correlationId: "expired",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  await resolver.requestEmailVerification({
    email: "recipient@example.invalid",
    correlationId: "binding",
  });
  const boundToken = mail.verificationMessages[1]?.token ?? "";
  await db.execute(
    sql`update "user" set email = 'changed@example.invalid' where email = 'recipient@example.invalid'`,
  );
  expect(
    await resolver.confirmEmailVerification({
      token: boundToken,
      correlationId: "changed",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  await resolver.requestEmailVerification({
    email: "changed@example.invalid",
    correlationId: "wrong",
  });
  const wrongToken = mail.verificationMessages[2]?.token ?? "";
  await db.execute(
    sql`update verification set value = ${JSON.stringify({ userId: "nonexistent-user", email: "changed@example.invalid" })}`,
  );
  expect(
    await resolver.confirmEmailVerification({
      token: wrongToken,
      correlationId: "wrong",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(
    (await db.execute(sql`select id from "user" where email_verified = true`))
      .rows,
  ).toHaveLength(0);
});

it("keeps known/unknown and recipient mail failure opaque; missing config fails uniformly", async () => {
  const resolver = configure(true, true);
  await signup();
  const known = await resolver.requestEmailVerification({
    email: "recipient@example.invalid",
    correlationId: "opaque",
  });
  expect(known).toEqual({ ok: true, value: undefined });
  expect(
    await resolver.requestEmailVerification({
      email: "unknown@example.invalid",
      correlationId: "opaque",
    }),
  ).toEqual(known);
  expect(mail.failures).toMatchObject([{ kind: "verification" }]);
  expect(await countRows(db, "verification")).toBe(1);
  const missing = configure(false);
  const a = await missing.requestEmailVerification({
    email: "recipient@example.invalid",
    correlationId: "missing",
  });
  expect(a).toMatchObject({
    ok: false,
    error: { code: "DEPENDENCY_UNAVAILABLE" },
  });
  expect(
    await missing.requestEmailVerification({
      email: "unknown@example.invalid",
      correlationId: "missing",
    }),
  ).toEqual(a);
});

it("rolls back consumption on update failure and permits retry without leaking details", async () => {
  const resolver = configure();
  await signup();
  await resolver.requestEmailVerification({
    email: "recipient@example.invalid",
    correlationId: "request",
  });
  const token = mail.verificationMessages[0]?.token ?? "";
  await db.execute(
    sql`create function b_test_fail_verify() returns trigger language plpgsql as $$ begin raise exception 'synthetic verification fault'; end $$`,
  );
  await db.execute(
    sql`create trigger b_fail_verify before update on "user" for each row execute function b_test_fail_verify()`,
  );
  try {
    const result = await resolver.confirmEmailVerification({
      token,
      correlationId: "rollback",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(
      "synthetic verification fault",
    );
    expect(await countRows(db, "verification")).toBe(1);
    expect(
      (await db.execute(sql`select id from "user" where email_verified = true`))
        .rows,
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`drop trigger b_fail_verify on "user"`);
    await db.execute(sql`drop function b_test_fail_verify()`);
  }
  expect(
    await resolver.confirmEmailVerification({ token, correlationId: "retry" }),
  ).toEqual({ ok: true, value: undefined });
});

it("blocks SDK JWT verification and foreign callback bypasses", async () => {
  const person = await signup();
  await expect(
    auth.api.verifyEmail({
      query: { token: "arbitrary", callbackURL: "https://foreign.invalid" },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    auth.api.sendVerificationEmail({
      body: {
        email: person.response.user.email,
        callbackURL: "https://foreign.invalid",
      },
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(
    (
      await auth.handler(
        new Request(`${appUrl}/api/auth/verify-email?token=arbitrary`),
      )
    ).status,
  ).toBe(404);
  expect(await countRows(db, "verification")).toBe(0);
});

it("keeps ordinary sign-in advisory and lets a verified matching recipient accept an invitation", async () => {
  const resolver = configure();
  const owner = await signup("owner@example.invalid");
  const org = await auth.api.createOrganization({
    headers: headers(owner),
    body: { name: "Synthetic Org", slug: "verification-org" },
  });
  if (!org) throw new Error("expected synthetic org");
  const person = await signup();
  await auth.api.signInEmail({
    body: { email: person.response.user.email, password },
  });
  await auth.api.createInvitation({
    headers: headers(owner),
    body: {
      organizationId: org.id,
      email: person.response.user.email,
      role: "volunteer",
    },
  });
  const invitationId = mail.invitationMessages[0]?.invitationId ?? "";
  const input = {
    headers: headers(person),
    invitationId,
    correlationId: "accept",
  };
  expect(await resolver.acceptInvitation(input)).toMatchObject({ ok: false });
  await resolver.requestEmailVerification({
    email: person.response.user.email,
    correlationId: "request",
  });
  expect(
    await resolver.confirmEmailVerification({
      token: mail.verificationMessages[0]?.token ?? "",
      correlationId: "verify",
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(await countRows(db, "member")).toBe(1);
  expect(await resolver.acceptInvitation(input)).toMatchObject({
    ok: true,
    value: { organizationId: org.id },
  });
  expect(await countRows(db, "member")).toBe(2);
});

it("does not verify a replacement account with the same email", async () => {
  const resolver = configure();
  const original = await signup();
  await resolver.requestEmailVerification({
    email: original.response.user.email,
    correlationId: "original",
  });
  const token = mail.verificationMessages[0]?.token ?? "";
  await db.execute(
    sql`delete from "user" where id = ${original.response.user.id}`,
  );
  const replacement = await signup();
  expect(replacement.response.user.id).not.toBe(original.response.user.id);
  expect(
    await resolver.confirmEmailVerification({
      token,
      correlationId: "replacement",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(
    (
      await db.execute(
        sql`select email_verified from "user" where id = ${replacement.response.user.id}`,
      )
    ).rows,
  ).toEqual([{ email_verified: false }]);
});
