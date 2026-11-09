import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  type Database,
  eq,
  schema,
  seedOrganizations,
  sql,
} from "../../../packages/db/src/index.ts";
import {
  openTestDatabase,
  resetAuthTables,
  resolveTestDatabaseUrl,
} from "../auth/support.ts";

// Starts its own production `next start` against the verified private *_test
// database. The port is configurable so parallel checkouts never collide; an
// occupied port is refused rather than reused.
const port = Number(process.env.HTTP_AUTH_TEST_PORT ?? "3186");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("HTTP_AUTH_TEST_PORT must be an unprivileged TCP port");
const distDir = process.env.RELAY_NEXT_DIST_DIR ?? ".next";
const origin = `http://localhost:${port}`;
const password = "synthetic-http-password-12";
let db: Database;
let close: (() => Promise<void>) | undefined;
let server: ChildProcess | undefined;
const cookies = new Map<string, string>();
function capture(response: Response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";", 1)[0];
    if (!pair) continue;
    const at = pair.indexOf("=");
    cookies.set(pair.slice(0, at), pair.slice(at + 1));
  }
}
async function call(
  path: string,
  value?: unknown,
  options: { anonymous?: boolean; origin?: string } = {},
) {
  const response = await fetch(`${origin}/api/auth/${path}`, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      ...(value !== undefined
        ? {
            "content-type": "application/json",
            origin: options.origin ?? origin,
          }
        : {}),
      ...(!options.anonymous
        ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
        : {}),
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {}),
  });
  capture(response);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: await response.json() };
}
async function signup(email = "http-person@example.invalid") {
  const result = await call("sign-up", {
    name: "Synthetic HTTP Person",
    email,
    password,
  });
  expect(result).toEqual({ status: 200, body: { ok: true } });
  const rows = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, email));
  expect(rows).toHaveLength(1);
  return rows[0]?.id as string;
}
// Binds a port only to learn a free one, then releases it. Nothing listens
// there afterwards, so mail delivery fails fast with a refused connection and
// never reaches a developer's local SMTP catcher.
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No probe port")),
      );
    });
  });
}
beforeAll(async () => {
  // Same guard as every DB-backed suite: a *_test name distinct from DATABASE_URL.
  const testDatabaseUrl = resolveTestDatabaseUrl();
  if (!existsSync(`apps/web/${distDir}/BUILD_ID`))
    throw new Error(
      `No production build in apps/web/${distDir}: run \`bun run build\` first`,
    );
  // Refuse an occupied application port without disturbing its owner.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", () =>
      reject(new Error(`Port ${port} is in use; set HTTP_AUTH_TEST_PORT`)),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
  const smtpPort = await closedPort();
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  server = spawn(
    process.execPath,
    [
      "apps/web/node_modules/next/dist/bin/next",
      "start",
      "apps/web",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: testDatabaseUrl,
        APP_URL: origin,
        // A synthetic per-suite secret unless the caller supplies one.
        BETTER_AUTH_SECRET:
          process.env.BETTER_AUTH_SECRET ??
          "local-http-synthetic-secret-".padEnd(48, "x"),
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtpPort),
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "ignore",
    },
  );
  for (let attempt = 0; attempt < 300; attempt++) {
    if (server.exitCode !== null) throw new Error("Private Next server exited");
    try {
      const health = await fetch(`${origin}/api/health`);
      if (health.ok) return;
    } catch {}
    await setTimeout(100);
  }
  throw new Error("Private Next server did not become ready");
});
afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await once(server, "exit");
  }
  await close?.();
});
beforeEach(async () => {
  cookies.clear();
  await resetAuthTables(db);
  await seedOrganizations(db);
});
it("real HTTP signup creates no membership, cookie signin/signout invalidates session", async () => {
  const userId = await signup();
  expect(
    await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, userId)),
  ).toHaveLength(0);
  expect(await call("organizations")).toEqual({
    status: 200,
    body: { ok: true, value: { currentOrganizationId: null, options: [] } },
  });
  expect(await call("sign-out", {})).toEqual({
    status: 200,
    body: { ok: true },
  });
  expect((await call("organizations")).status).toBe(401);
  expect(
    await call("sign-in", { email: "http-person@example.invalid", password }),
  ).toEqual({ status: 200, body: { ok: true } });
  expect((await call("organizations")).status).toBe(200);
  const stale = [...cookies];
  await call("sign-out", {});
  cookies.clear();
  for (const [k, v] of stale) cookies.set(k, v);
  expect((await call("organizations")).status).toBe(401);
});
it("lists live memberships, selects only own tenant and drops revoked selection", async () => {
  const id = await signup();
  await db.insert(schema.member).values([
    {
      id: "http-member-a",
      organizationId: "tidepath",
      userId: id,
      role: "volunteer",
    },
    {
      id: "http-member-b",
      organizationId: "harbor",
      userId: id,
      role: "report-reader",
    },
  ]);
  const choices = await call("organizations");
  expect(choices.status).toBe(200);
  expect(choices.body.value.options).toEqual(
    expect.arrayContaining([
      {
        organizationId: "tidepath",
        membershipId: "http-member-a",
        name: "Tidepath Mutual Aid",
        slug: "tidepath",
        role: "volunteer",
      },
      {
        organizationId: "harbor",
        membershipId: "http-member-b",
        name: "Harbor Neighbour Network",
        slug: "harbor",
        role: "report-reader",
      },
    ]),
  );
  expect(choices.body.value.options).toHaveLength(2);
  expect(
    await call("organizations/select", { organizationId: "tidepath" }),
  ).toEqual({ status: 200, body: { ok: true } });
  expect((await call("organizations")).body.value.currentOrganizationId).toBe(
    "tidepath",
  );
  await db.delete(schema.member).where(eq(schema.member.id, "http-member-a"));
  const revoked = await call("organizations");
  expect(revoked.body.value.currentOrganizationId).toBe(null);
  expect(
    revoked.body.value.options.map(
      (o: { organizationId: string }) => o.organizationId,
    ),
  ).toEqual(["harbor"]);
  expect(
    (await call("organizations/select", { organizationId: "tidepath" })).status,
  ).toBe(404);
  expect(
    (await call("organizations/select", { organizationId: "foreign" })).status,
  ).toBe(404);
  expect(
    await call("organizations/select", { organizationId: "harbor" }),
  ).toEqual({ status: 200, body: { ok: true } });
});
// Production composes an SMTP transport (apps/web/lib/mail/production.ts), so
// public mail requests are no longer refused as "not configured". This suite
// points SMTP at a closed local port: delivery fails for the known account
// only, and that failure must stay invisible, so the known and unknown
// accounts receive the same accepted response (no account enumeration).
it("production mail requests are uniform when delivery fails and invalid confirmations stay bounded", async () => {
  await signup();
  for (const email of [
    "http-person@example.invalid",
    "unknown@example.invalid",
  ]) {
    for (const path of ["reset/request", "verification/request"]) {
      expect(await call(path, { email }), `${path} ${email}`).toEqual({
        status: 200,
        body: { ok: true },
      });
    }
  }
  // The known account's tokens persist for a retry despite the failed send.
  const pending = await db.execute(
    sql`select count(*)::int as count from verification`,
  );
  expect((pending.rows[0] as { count: number }).count).toBeGreaterThan(0);
  expect(
    (await call("reset/confirm", { token: "invalid", newPassword: password }))
      .status,
  ).toBe(422);
  expect(
    (await call("verification/confirm", { token: "invalid" })).status,
  ).toBe(422);
});
it("requires verified matching invitation recipient and does not expose SDK response", async () => {
  const id = await signup();
  await db.insert(schema.invitation).values({
    id: "http-invitation",
    organizationId: "tidepath",
    email: "http-person@example.invalid",
    role: "volunteer",
    expiresAt: new Date(Date.now() + 60000),
    inviterId: "user-rae",
  });
  const unverified = await call("invitations/accept", {
    invitationId: "http-invitation",
  });
  expect(unverified.status).toBe(403);
  expect(unverified.body.error.code).toBe("EMAIL_NOT_VERIFIED");
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(eq(schema.user.id, id));
  expect(
    await call("invitations/accept", { invitationId: "http-invitation" }),
  ).toEqual({ status: 200, body: { ok: true } });
  expect(
    (await call("organizations")).body.value.options.map(
      (o: { organizationId: string }) => o.organizationId,
    ),
  ).toEqual(["tidepath"]);
  // Single use: a replay is the neutral answer, like an unknown id.
  const replay = await call("invitations/accept", {
    invitationId: "http-invitation",
  });
  expect(replay.status).toBe(404);
  expect(replay.body.error.code).toBe("NOT_AVAILABLE");
});
it("enforces strict inputs and configured origin on real explicit routes", async () => {
  expect(
    (
      await call("sign-up", {
        name: "Synthetic",
        email: "other@example.invalid",
        password,
        userId: "forged",
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call(
        "sign-in",
        { email: "other@example.invalid", password },
        { origin: "https://evil.invalid" },
      )
    ).status,
  ).toBe(403);
  const missing = await fetch(`${origin}/api/auth/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "other@example.invalid", password }),
  });
  expect(missing.status).toBe(403);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const rows = await db.execute(
    sql`select count(*)::int as count from "user" where email = 'other@example.invalid'`,
  );
  expect(rows.rows[0]).toEqual({ count: 0 });
  expect((await fetch(`${origin}/api/auth/admin`)).status).toBe(404);
});

it("returns canonical no-store denial for every unsupported Next route method", async () => {
  const routes = [
    ["sign-in", "POST"],
    ["sign-up", "POST"],
    ["sign-out", "POST"],
    ["reset/request", "POST"],
    ["reset/confirm", "POST"],
    ["verification/request", "POST"],
    ["verification/confirm", "POST"],
    ["invitations/accept", "POST"],
    ["organizations/select", "POST"],
    ["organizations", "GET"],
  ] as const;
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
  for (const [path, supported] of routes) {
    for (const method of methods) {
      if (method === supported) continue;
      // No Origin: the strict method guard must run before origin/body/SDK work.
      const response = await fetch(`${origin}/api/auth/${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(422);
      expect(response.headers.get("cache-control"), `${method} ${path}`).toBe(
        "no-store",
      );
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(response.headers.getSetCookie()).toEqual([]);
      if (method === "HEAD") {
        expect(await response.text()).toBe("");
      } else {
        expect(await response.json()).toEqual({
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Request cannot be completed",
            correlationId: expect.any(String),
            retryable: false,
          },
        });
      }
    }
  }
  // Method denials create no users, sessions, tenant membership or mail tokens.
  const counts = await db.execute(sql`
    select (select count(*)::int from "user") as users,
      (select count(*)::int from "session") as sessions,
      (select count(*)::int from member) as members,
      (select count(*)::int from verification) as verifications
  `);
  expect(counts.rows).toEqual([
    { users: 5, sessions: 0, members: 6, verifications: 0 },
  ]);
});
