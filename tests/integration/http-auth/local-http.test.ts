import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
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
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

const origin = "http://localhost:3186";
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
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55465" ||
    url.pathname !== "/relay_b_p1_12_test"
  )
    throw new Error("Use the assigned P1-12 private test database only");
  // Refuse an occupied application port without disturbing its owner.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(3186, "127.0.0.1", () => probe.close(() => resolve()));
  });
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
      "3186",
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        APP_URL: origin,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: "ignore",
    },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
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
it("production unavailable mail is uniform and invalid confirmations stay bounded", async () => {
  await signup();
  for (const email of [
    "http-person@example.invalid",
    "unknown@example.invalid",
  ]) {
    for (const path of ["reset/request", "verification/request"]) {
      const response = await call(path, { email });
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    }
  }
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
  expect(
    (await call("invitations/accept", { invitationId: "http-invitation" }))
      .status,
  ).toBe(403);
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
  expect(
    (await call("invitations/accept", { invitationId: "http-invitation" }))
      .status,
  ).toBe(403);
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
