import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  recordMailDeliveryFailure,
  trackMailDelivery,
} from "../../../apps/web/lib/auth/delivery.ts";
import {
  type Auth,
  createSessionResolver,
} from "../../../apps/web/lib/auth/index.ts";
import {
  type AuthHttpDependencies,
  createAuthHttpHandlers,
} from "../../../apps/web/lib/auth-http/index.ts";
import {
  clientAddress,
  createRateLimiter,
} from "../../../apps/web/lib/auth-http/rate-limit.ts";

// Database-free: every dependency is a controlled synthetic adapter.
const appUrl = "http://localhost:3186";
const success = { ok: true as const, value: undefined };

describe("per-call mail delivery outcome", () => {
  it("isolates concurrent calls", async () => {
    const [failing, delivering] = await Promise.all([
      trackMailDelivery(async () => {
        await delay(5);
        recordMailDeliveryFailure("invitation");
        return "a";
      }),
      trackMailDelivery(async () => {
        await delay(1);
        return "b";
      }),
    ]);
    expect(failing.value).toBe("a");
    expect([...failing.failed]).toEqual(["invitation"]);
    expect(delivering.value).toBe("b");
    expect(delivering.failed.size).toBe(0);
  });

  it("ignores failures outside a tracked call", async () => {
    recordMailDeliveryFailure("reset");
    const outcome = await trackMailDelivery(async () => 1);
    expect(outcome.failed.size).toBe(0);
  });
});

describe("invitation creation reports delivery per request", () => {
  // Stands in for Better Auth: the invitation row is created, then the
  // configured mail callback fails for the "unreachable" recipient.
  function resolver(mailConfigured = true) {
    let next = 0;
    const createInvitation = vi.fn(
      async ({ body }: { body: { email: string } }) => {
        next += 1;
        const id = `invitation-${next}`;
        await delay(body.email.startsWith("unreachable") ? 5 : 1);
        if (body.email.startsWith("unreachable"))
          recordMailDeliveryFailure("invitation");
        return { response: { id }, headers: new Headers() };
      },
    );
    const auth = { api: { createInvitation } } as unknown as Auth;
    return {
      createInvitation,
      sessions: createSessionResolver({
        auth,
        authorization: {} as never,
        memberships: {} as never,
        appUrl,
        mailConfigured,
      }),
    };
  }
  const invite = (email: string) => ({
    headers: new Headers(),
    organizationId: "org-synthetic",
    email,
    role: "volunteer",
    correlationId: `corr-${email}`,
  });

  it("fails only the request whose delivery failed", async () => {
    const { sessions } = resolver();
    const [failed, delivered] = await Promise.all([
      sessions.createInvitation(invite("unreachable@example.invalid")),
      sessions.createInvitation(invite("reachable@example.invalid")),
    ]);
    expect(failed).toEqual({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Invitation delivery is unavailable",
        correlationId: "corr-unreachable@example.invalid",
        retryable: true,
      },
    });
    expect(delivered).toMatchObject({ ok: true });
  });

  it("refuses to create an invitation that cannot be delivered", async () => {
    const { sessions, createInvitation } = resolver(false);
    expect(
      await sessions.createInvitation(invite("reachable@example.invalid")),
    ).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", retryable: false },
    });
    expect(createInvitation).not.toHaveBeenCalled();
  });
});

describe("rate limiter", () => {
  const rule = { limit: 2, windowMs: 60_000 };

  it("blocks at the limit and reopens after the window", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ now: () => now });
    expect(limiter.blocked("k", rule)).toBeNull();
    limiter.hit("k", rule);
    limiter.hit("k", rule);
    expect(limiter.blocked("k", rule)).toBe(60);
    now += 30_000;
    expect(limiter.blocked("k", rule)).toBe(30);
    now += 30_000;
    expect(limiter.blocked("k", rule)).toBeNull();
  });

  it("refunds a counted use", () => {
    const limiter = createRateLimiter();
    limiter.hit("k", rule);
    limiter.hit("k", rule);
    limiter.release("k");
    expect(limiter.blocked("k", rule)).toBeNull();
  });

  it("keeps a bounded number of windows", () => {
    const limiter = createRateLimiter({ maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) {
      limiter.hit(key, { limit: 1, windowMs: 60_000 });
    }
    // The oldest window was evicted to admit "d".
    expect(limiter.blocked("a", { limit: 1, windowMs: 60_000 })).toBeNull();
    expect(limiter.blocked("d", { limit: 1, windowMs: 60_000 })).toBe(60);
  });
});

describe("client address", () => {
  const at = (headers: Record<string, string>) =>
    clientAddress(new Request(appUrl, { headers }));

  it("uses the proxy-appended right-most forwarded entry", () => {
    expect(at({ "x-forwarded-for": "203.0.113.9" })).toBe("203.0.113.9");
    // A client-supplied left-hand value cannot choose the bucket.
    expect(at({ "x-forwarded-for": "198.51.100.1, 203.0.113.9" })).toBe(
      "203.0.113.9",
    );
    expect(at({ "x-forwarded-for": "2001:db8::1" })).toBe("2001:db8::1");
  });

  it("falls back to one shared bucket without a usable header", () => {
    expect(at({})).toBe("unknown");
    expect(at({ "x-forwarded-for": "not an address" })).toBe("unknown");
  });
});

describe("auth route limits", () => {
  function fixture(signInStatus = 401) {
    const sdk = vi.fn(async () => new Response("{}", { status: signInStatus }));
    const sessions = {
      requestPasswordReset: vi.fn(async () => success),
      resetPassword: vi.fn(async () => success),
      requestEmailVerification: vi.fn(async () => success),
      confirmEmailVerification: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "VALIDATION" as const,
          message: "x",
          correlationId: "x",
          retryable: false,
        },
      })),
      acceptInvitation: vi.fn(async () => success),
      switchOrganization: vi.fn(async () => success),
      listAvailableOrganizations: vi.fn(async () => ({
        ok: true as const,
        value: [],
      })),
    };
    const dependencies = {
      appUrl,
      auth: {
        api: {
          signInEmail: sdk,
          signUpEmail: sdk,
          signOut: sdk,
          getSession: vi.fn(),
        },
      },
      sessions,
      rateRules: {
        signInPerAccount: { limit: 3, windowMs: 60_000 },
        signInPerAddress: { limit: 5, windowMs: 60_000 },
        mailRequestPerAccount: { limit: 2, windowMs: 60_000 },
        mailRequestPerAddress: { limit: 4, windowMs: 60_000 },
        tokenConfirmPerAddress: { limit: 2, windowMs: 60_000 },
      },
    } as unknown as AuthHttpDependencies;
    return { handlers: createAuthHttpHandlers(dependencies), sdk, sessions };
  }
  function post(value: unknown, address = "203.0.113.9") {
    return new Request(`${appUrl}/api/auth/x`, {
      method: "POST",
      headers: {
        origin: appUrl,
        "content-type": "application/json",
        "x-forwarded-for": address,
      },
      body: JSON.stringify(value),
    });
  }
  const credentials = (email: string) => ({ email, password: "synthetic-pw" });

  it("locks an account after repeated failed sign-ins, from any address", async () => {
    const { handlers, sdk } = fixture();
    for (const address of ["203.0.113.1", "203.0.113.2", "203.0.113.3"])
      expect(
        (await handlers.signIn(post(credentials("a@example.invalid"), address)))
          .status,
      ).toBe(401);
    const denied = await handlers.signIn(
      post(credentials("A@Example.invalid"), "203.0.113.4"),
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");
    expect(await denied.json()).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Try again later",
        correlationId: expect.any(String),
        retryable: true,
      },
    });
    expect(sdk).toHaveBeenCalledTimes(3);
  });

  it("limits one address across many accounts", async () => {
    const { handlers } = fixture();
    for (let n = 0; n < 5; n++)
      expect(
        (await handlers.signIn(post(credentials(`u${n}@example.invalid`))))
          .status,
      ).toBe(401);
    expect(
      (await handlers.signIn(post(credentials("u9@example.invalid")))).status,
    ).toBe(429);
    // Another address is unaffected.
    expect(
      (
        await handlers.signIn(
          post(credentials("u9@example.invalid"), "198.51.100.7"),
        )
      ).status,
    ).toBe(401);
  });

  it("does not count successful sign-ins", async () => {
    const { handlers } = fixture(200);
    for (let n = 0; n < 8; n++)
      expect(
        (await handlers.signIn(post(credentials("ok@example.invalid")))).status,
      ).toBe(200);
  });

  it("caps reset and verification mail per account, across both routes", async () => {
    const { handlers, sessions } = fixture();
    const target = { email: "target@example.invalid" };
    expect((await handlers.requestReset(post(target))).status).toBe(200);
    expect((await handlers.requestVerification(post(target))).status).toBe(200);
    expect((await handlers.requestReset(post(target))).status).toBe(429);
    expect((await handlers.requestVerification(post(target))).status).toBe(429);
    expect(sessions.requestPasswordReset).toHaveBeenCalledTimes(1);
    expect(sessions.requestEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("limits token guessing per address", async () => {
    const { handlers, sessions } = fixture();
    const token = { token: "A".repeat(43) };
    expect((await handlers.confirmVerification(post(token))).status).toBe(422);
    expect((await handlers.confirmVerification(post(token))).status).toBe(422);
    expect((await handlers.confirmVerification(post(token))).status).toBe(429);
    expect(sessions.confirmEmailVerification).toHaveBeenCalledTimes(2);
  });
});
