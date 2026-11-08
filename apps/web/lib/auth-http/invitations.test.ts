import { describe, expect, it, vi } from "vitest";
import { type AuthHttpDependencies, createAuthHttpHandlers } from "./index.ts";
import { createRateLimiter } from "./rate-limit.ts";

const appUrl = "http://localhost:3186";
const listed = {
  emailVerified: true,
  invitations: [
    {
      invitationId: "invitation-a",
      organizationName: "Synthetic Garden",
      role: "volunteer" as const,
      expiresAt: "2026-03-02T00:00:00.000Z",
    },
  ],
};

function fixture(rule = { limit: 3, windowMs: 60_000 }) {
  const listPendingInvitations = vi.fn(
    async (input: { responseHeaders?: Headers }) => {
      input.responseHeaders?.append("set-cookie", "renewed=1");
      return { ok: true as const, value: listed };
    },
  );
  const handlers = createAuthHttpHandlers({
    appUrl,
    auth: { api: {} },
    sessions: { listPendingInvitations },
    rateLimiter: createRateLimiter(),
    clientAddress: () => "203.0.113.7",
    rateRules: { invitationListPerAddress: rule },
  } as unknown as AuthHttpDependencies);
  return { handlers, listPendingInvitations };
}

const get = (headers: Record<string, string> = {}) =>
  new Request(`${appUrl}/api/auth/invitations`, {
    headers: { cookie: "session=synthetic", ...headers },
  });

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    ok: false,
    error: {
      code,
      message: expect.any(String),
      correlationId: expect.any(String),
      retryable: expect.any(Boolean),
    },
  });
}

describe("GET /api/auth/invitations", () => {
  it("returns the resolver projection with no-store and renewed cookies", async () => {
    const { handlers, listPendingInvitations } = fixture();
    const response = await handlers.invitations(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual(["renewed=1"]);
    expect(await response.json()).toEqual({ ok: true, value: listed });
    const [input] = listPendingInvitations.mock.calls[0] ?? [];
    // Only the request's own headers travel; no query or body is consulted.
    expect(Object.keys(input ?? {}).sort()).toEqual([
      "correlationId",
      "headers",
      "responseHeaders",
    ]);
  });

  it("maps a missing session to the 401 envelope", async () => {
    const { handlers, listPendingInvitations } = fixture();
    listPendingInvitations.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "PRIVATE detail",
        correlationId: "inner",
        retryable: false,
      },
    } as never);
    const response = await handlers.invitations(get());
    const text = await response.clone().text();
    expect(text).not.toContain("PRIVATE");
    await expectError(response, 401, "UNAUTHENTICATED");
  });

  it("refuses other methods without running the lookup", async () => {
    const { handlers, listPendingInvitations } = fixture();
    for (const method of ["POST", "PUT", "DELETE"]) {
      await expectError(
        await handlers.invitations(
          new Request(`${appUrl}/api/auth/invitations`, {
            method,
            headers: { origin: appUrl, "content-type": "application/json" },
            body: "{}",
          }),
        ),
        422,
        "VALIDATION",
      );
    }
    expect(listPendingInvitations).not.toHaveBeenCalled();
  });

  it("rate limits per address with retry-after and stops calling the lookup", async () => {
    const { handlers, listPendingInvitations } = fixture({
      limit: 2,
      windowMs: 60_000,
    });
    expect((await handlers.invitations(get())).status).toBe(200);
    expect((await handlers.invitations(get())).status).toBe(200);
    const limited = await handlers.invitations(get());
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    await expectError(limited, 429, "RATE_LIMITED");
    expect(listPendingInvitations).toHaveBeenCalledTimes(2);
  });

  it("hides unexpected lookup errors", async () => {
    const { handlers, listPendingInvitations } = fixture();
    listPendingInvitations.mockRejectedValueOnce(new Error("PRIVATE"));
    const response = await handlers.invitations(get());
    expect(await response.clone().text()).not.toContain("PRIVATE");
    await expectError(response, 503, "DEPENDENCY_UNAVAILABLE");
  });
});
