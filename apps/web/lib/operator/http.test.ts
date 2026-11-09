import type { ErrorCode, Result } from "@relay/contracts";
import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../auth-http/rate-limit.ts";
import {
  createOperatorHandler,
  OPERATOR_SESSION_MAX_AGE_MS,
  type OperatorSessionActor,
} from "./http.ts";
import type { OperatorService } from "./service.ts";

const appUrl = "https://relay.example.org";
const fresh = {
  userId: "operator-1",
  sessionCreatedAt: new Date("2026-01-01T00:00:00Z"),
};
const denial = (code: ErrorCode): Promise<Result<OperatorSessionActor>> =>
  Promise.resolve({
    ok: false,
    error: { code, message: "", correlationId: "c", retryable: false },
  });

function fakeService(overrides: Partial<OperatorService> = {}) {
  const calls: { name: string; input: unknown }[] = [];
  const service: OperatorService = {
    async list(query) {
      calls.push({ name: "list", input: query });
      return {
        ok: true,
        value: {
          organizations: [],
          nextCursor: null,
        },
      };
    },
    async detail(input) {
      calls.push({ name: "detail", input });
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "",
          correlationId: input.correlationId,
          retryable: false,
        },
      };
    },
    async createOrganization(input) {
      calls.push({ name: "createOrganization", input });
      return { ok: true, value: { organizationId: "org-new" } };
    },
    async setMemberRole(input) {
      calls.push({ name: "setMemberRole", input });
      return { ok: true, value: undefined };
    },
    ...overrides,
  };
  return { calls, service };
}

const detailFixture = {
  organization: {
    organizationId: "org-1",
    name: "Tidepath",
    slug: "tidepath",
    createdAt: "2026-01-01T00:00:00.000Z",
    members: {
      owner: 1,
      coordinator: 0,
      volunteer: 0,
      reportReader: 0,
      total: 1,
    },
    owners: [
      {
        membershipId: "member-1",
        name: "Synthetic Owner",
        maskedEmail: "o•••@example.org",
        joinedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    ownersTruncated: false,
    pendingInvitations: 0,
  },
  members: [],
  membersTruncated: false,
};

/** Fake service whose detail read succeeds, for route-coverage tests. */
function coverageService() {
  const { calls, service } = fakeService();
  return {
    calls,
    service: {
      ...service,
      async detail(input: { organizationId: string; correlationId: string }) {
        calls.push({ name: "detail", input });
        return { ok: true as const, value: detailFixture };
      },
    },
  };
}

function handler(
  options: {
    resolve?: (
      request: Request,
      responseHeaders: Headers,
    ) => Promise<Result<OperatorSessionActor>>;
    service?: OperatorService;
    now?: () => Date;
    rules?: {
      read: { limit: number; windowMs: number };
      write: { limit: number; windowMs: number };
    };
  } = {},
) {
  const { service } = fakeService(options.service ? {} : {});
  return createOperatorHandler({
    appUrl,
    resolve: options.resolve ?? (async () => ({ ok: true, value: fresh })),
    service: options.service ?? service,
    now: options.now ?? (() => new Date("2026-01-01T00:05:00Z")),
    ...(options.rules
      ? { rateLimiter: createRateLimiter(), rateRules: options.rules }
      : {}),
  });
}

const get = (path: string, init: RequestInit = {}) =>
  new Request(`${appUrl}/api/operator/${path}`, { method: "GET", ...init });
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`${appUrl}/api/operator/${path}`, {
    method: "POST",
    headers: { origin: appUrl, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("operator transport", () => {
  it("answers the session probe only for an operator", async () => {
    const response = await handler()(get("session"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      value: { operator: true },
    });
  });

  it("renders every non-operator state as an identical not found", async () => {
    for (const code of ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"] as const) {
      const response = await handler({ resolve: () => denial(code) })(
        get("organizations"),
      );
      expect(response.status).toBe(404);
      const body = (await response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe("Resource was not found");
    }
  });

  it("keeps an outage distinguishable from a permission refusal", async () => {
    const response = await handler({
      resolve: () => denial("DEPENDENCY_UNAVAILABLE"),
    })(get("session"));
    expect(response.status).toBe(503);
  });

  it("allows only GET and POST", async () => {
    const response = await handler()(
      new Request(`${appUrl}/api/operator/session`, { method: "DELETE" }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });

  it("requires the application origin on a mutation", async () => {
    const response = await handler()(
      post("member-role", {}, { origin: "https://attacker.example" }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires a recently created session for a mutation", async () => {
    const stale = {
      userId: "operator-1",
      sessionCreatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const response = await handler({
      resolve: async () => ({ ok: true, value: stale }),
      now: () =>
        new Date(
          stale.sessionCreatedAt.getTime() + OPERATOR_SESSION_MAX_AGE_MS + 1,
        ),
    })(post("member-role", {}));
    expect(response.status).toBe(403);
    // A read is not freshness bound: an operator can browse an older session.
    const read = await handler({
      resolve: async () => ({ ok: true, value: stale }),
      now: () =>
        new Date(
          stale.sessionCreatedAt.getTime() + OPERATOR_SESSION_MAX_AGE_MS + 1,
        ),
    })(get("session"));
    expect(read.status).toBe(200);
  });

  it("validates the search query and its parameters", async () => {
    for (const path of [
      "organizations?q=a",
      "organizations?q=50%25",
      "organizations?cursor=!!!",
      "organizations?sort=name",
    ]) {
      const response = await handler()(get(path));
      expect(response.status).toBe(422);
    }
    const ok = await handler()(get("organizations?q=tide"));
    expect(ok.status).toBe(200);
  });

  it("dispatches the list read with the resolved actor's authority only", async () => {
    const { calls, service } = fakeService();
    const response = await handler({ service })(get("organizations?q=tide"));
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ name: "list", input: { q: "tide" } }]);
  });

  it("rejects a malformed body and an oversized body before dispatch", async () => {
    const { calls, service } = fakeService();
    const run = handler({ service });
    const malformed = await run(
      new Request(`${appUrl}/api/operator/organizations`, {
        method: "POST",
        headers: { origin: appUrl, "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(malformed.status).toBe(422);
    const oversized = await run(
      post("organizations", {
        name: "x".repeat(9000),
        slug: "x",
        timezone: "UTC",
        ownerEmail: "owner@example.org",
      }),
    );
    expect(oversized.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it("dispatches creation and role changes with the correlation id", async () => {
    const { calls, service } = fakeService();
    const run = handler({ service });
    const created = await run(
      post("organizations", {
        name: "Example",
        slug: "example",
        timezone: "America/New_York",
        ownerEmail: "owner@example.org",
      }),
    );
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      ok: true,
      value: { organizationId: "org-new" },
    });
    const changed = await run(
      post("member-role", {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual({ ok: true, value: {} });
    expect(calls.map((call) => call.name)).toEqual([
      "createOrganization",
      "setMemberRole",
    ]);
    for (const call of calls) {
      const input = call.input as {
        actor: { userId: string };
        correlationId: string;
      };
      expect(input.actor.userId).toBe("operator-1");
      expect(input.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("preserves a service refusal and its status", async () => {
    const { service } = fakeService({
      async setMemberRole(input) {
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "The record changed. Refresh and try again",
            correlationId: input.correlationId,
            retryable: false,
          },
        };
      },
    });
    const response = await handler({ service })(
      post("member-role", {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "coordinator",
        expectedRole: "owner",
      }),
    );
    expect(response.status).toBe(409);
  });

  it("answers an unknown path, and an unknown write path, without dispatch", async () => {
    const { calls, service } = fakeService();
    const run = handler({ service });
    expect((await run(get("unknown"))).status).toBe(404);
    expect((await run(post("unknown", {}))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("rate limits reads and writes per operator", async () => {
    const run = handler({
      rules: {
        read: { limit: 1, windowMs: 60_000 },
        write: { limit: 1, windowMs: 60_000 },
      },
    });
    expect((await run(get("session"))).status).toBe(200);
    expect((await run(get("session"))).status).toBe(429);
    const write = () =>
      post("member-role", {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      });
    expect((await run(write())).status).toBe(200);
    expect((await run(write())).status).toBe(429);
  });
});

describe("operator transport route coverage", () => {
  // Every path the console UI calls must be served. This is the regression test
  // for the defect that made "Manage owners" dead: the UI called a detail path
  // the transport never handled.
  const consolePaths = [
    { method: "GET" as const, path: "session" },
    { method: "GET" as const, path: "organizations?q=tide" },
    { method: "GET" as const, path: "organization?organizationId=org-1" },
    { method: "POST" as const, path: "organizations" },
    { method: "POST" as const, path: "member-role" },
  ];

  for (const entry of consolePaths) {
    it(`serves ${entry.method} ${entry.path}`, async () => {
      const { service } = coverageService();
      const response = await handler({ service })(
        entry.method === "GET"
          ? get(entry.path)
          : post(entry.path, {
              name: "Example",
              slug: "example",
              timezone: "America/New_York",
              ownerEmail: "owner@example.org",
              organizationId: "org-1",
              membershipId: "member-1",
              role: "owner",
              expectedRole: "coordinator",
            }),
      );
      expect(response.status).not.toBe(404);
    });
  }

  it("serves the detail read with only its own parameter", async () => {
    const { calls, service } = coverageService();
    const run = handler({ service });
    const detail = await run(get("organization?organizationId=org-1"));
    expect(detail.status).toBe(200);
    expect(
      (await run(get("organization?organizationId=org-1&x=1"))).status,
    ).toBe(422);
    expect(calls).toContainEqual({
      name: "detail",
      input: expect.objectContaining({ organizationId: "org-1" }),
    });
  });

  it("hides the method allowlist from an unauthenticated caller", async () => {
    const response = await handler({
      resolve: () => denial("UNAUTHENTICATED"),
    })(new Request(`${appUrl}/api/operator/session`, { method: "DELETE" }));
    expect(response.status).toBe(404);
  });

  it("sends a retry hint with a rate-limited response", async () => {
    const run = handler({
      rules: {
        read: { limit: 1, windowMs: 60_000 },
        write: { limit: 1, windowMs: 60_000 },
      },
    });
    await run(get("session"));
    const limited = await run(get("session"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
