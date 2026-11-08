import { describe, expect, it, vi } from "vitest";
import {
  type AuthHttpDependencies,
  createAuthHttpHandlers,
} from "../../../apps/web/lib/auth-http/index.ts";

const appUrl = "http://localhost:3186";
const success = { ok: true as const, value: undefined };
const option = {
  organizationId: "org-a",
  membershipId: "membership-a",
  name: "Synthetic",
  slug: "synthetic",
  role: "volunteer" as const,
};
function fixture() {
  const sdk = vi.fn(
    async () =>
      new Response('{"token":"PRIVATE","user":{"id":"PRIVATE"}}', {
        headers: { "set-cookie": "session=one; HttpOnly", "x-sdk": "retained" },
      }),
  );
  const sessions = {
    requestPasswordReset: vi.fn(async () => success),
    resetPassword: vi.fn(async () => success),
    requestEmailVerification: vi.fn(async () => success),
    confirmEmailVerification: vi.fn(async () => success),
    acceptInvitation: vi.fn(async () => success),
    switchOrganization: vi.fn(async () => success),
    listAvailableOrganizations: vi.fn(async () => ({
      ok: true as const,
      value: [option],
    })),
  };
  // Controlled SDK boundary: no replacement user/session entities are exported.
  const getSession = vi.fn(async () => ({
    headers: new Headers(),
    response: {
      user: { id: "verified" },
      session: { activeOrganizationId: "org-a" },
    },
  }));
  const dependencies = {
    appUrl,
    auth: {
      api: { signInEmail: sdk, signUpEmail: sdk, signOut: sdk, getSession },
    },
    sessions,
  } as unknown as AuthHttpDependencies;
  return {
    handlers: createAuthHttpHandlers(dependencies),
    sdk,
    sessions,
    getSession,
  };
}
function request(
  value: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Request(`${appUrl}/api/auth/sign-in`, {
    method,
    headers: { origin: appUrl, "content-type": "application/json", ...headers },
    ...(method !== "GET" ? { body: JSON.stringify(value) } : {}),
  });
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json();
  expect(data).toEqual({
    ok: false,
    error: {
      code,
      message: expect.any(String),
      correlationId: expect.any(String),
      retryable: expect.any(Boolean),
    },
  });
  expect(JSON.stringify(data)).not.toContain("PRIVATE");
}
const mutations = [
  ["signIn", { email: "synthetic@example.invalid", password: "secret" }],
  [
    "signUp",
    {
      name: "Synthetic",
      email: "synthetic@example.invalid",
      password: "secret",
    },
  ],
  ["signOut", {}],
  ["requestReset", { email: "synthetic@example.invalid" }],
  ["confirmReset", { token: "synthetic", newPassword: "secret" }],
  ["requestVerification", { email: "synthetic@example.invalid" }],
  ["confirmVerification", { token: "synthetic" }],
  ["acceptInvitation", { invitationId: "invite" }],
  ["selectOrganization", { organizationId: "org-a" }],
] as const;
describe("strict HTTP boundary", () => {
  for (const [name, input] of mutations) {
    it(`${name} returns only canonical void`, async () => {
      const { handlers } = fixture();
      const response = await handlers[name](request(input));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(response.headers.get("cache-control")).toBe("no-store");
    });
    it(`${name} rejects extra authority and callbacks`, async () => {
      const { handlers } = fixture();
      await error(
        await handlers[name](
          request({
            ...input,
            callbackURL: "https://evil.invalid",
            userId: "foreign",
          }),
        ),
        422,
        "VALIDATION",
      );
    });
    it(`${name} rejects foreign/missing/null origin and wrong methods`, async () => {
      const { handlers } = fixture();
      for (const origin of ["null", "https://evil.invalid", `${appUrl}/`, ""]) {
        await error(
          await handlers[name](
            request(input, { origin, "x-forwarded-host": "localhost:3186" }),
          ),
          403,
          "FORBIDDEN",
        );
      }
      const missing = request(input);
      missing.headers.delete("origin");
      await error(await handlers[name](missing), 403, "FORBIDDEN");
      await error(
        await handlers[name](request(input, {}, "GET")),
        422,
        "VALIDATION",
      );
    });
  }
  it("rejects JSON type, invalid encoding/JSON, oversized streamed bytes before SDK", async () => {
    const { handlers, sdk } = fixture();
    for (const [value, type] of [
      ["{}", "text/plain"],
      ["{", "application/json"],
      ["x".repeat(16385), "application/json"],
    ])
      await error(
        await handlers.signIn(
          new Request(appUrl, {
            method: "POST",
            headers: { origin: appUrl, "content-type": type as string },
            body: value ?? "",
          }),
        ),
        422,
        "VALIDATION",
      );
    await error(
      await handlers.signIn(
        new Request(appUrl, {
          method: "POST",
          headers: { origin: appUrl, "content-type": "application/json" },
          body: new Uint8Array([255]),
        }),
      ),
      422,
      "VALIDATION",
    );
    expect(sdk).not.toHaveBeenCalled();
  });
  it("enforces byte length even for multibyte data or lying content-length", async () => {
    const { handlers, sdk } = fixture();
    await error(
      await handlers.signIn(
        request(
          { email: "synthetic@example.invalid", password: "é".repeat(8200) },
          { "content-length": "2" },
        ),
      ),
      422,
      "VALIDATION",
    );
    expect(sdk).not.toHaveBeenCalled();
  });
  it("retains distinct cookies and SDK headers without SDK data", async () => {
    const { handlers, sdk } = fixture();
    const headers = new Headers({ "x-sdk": "retained" });
    headers.append(
      "set-cookie",
      "first=1; Expires=Wed, 09 Jun 2032 10:18:14 GMT",
    );
    headers.append("set-cookie", "second=2; HttpOnly");
    sdk.mockImplementation(async () => new Response("PRIVATE", { headers }));
    const response = await handlers.signIn(request(mutations[0][1]));
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(response.headers.get("x-sdk")).toBe("retained");
    expect(await response.json()).toEqual({ ok: true });
  });
  for (const [sdkStatus, code, status] of [
    [400, "VALIDATION", 422],
    [401, "UNAUTHENTICATED", 401],
    [403, "FORBIDDEN", 403],
    [404, "NOT_FOUND", 404],
    [409, "CONFLICT", 409],
    [429, "RATE_LIMITED", 429],
    [500, "DEPENDENCY_UNAVAILABLE", 503],
  ] as const)
    it(`sanitizes SDK ${sdkStatus}`, async () => {
      const { handlers, sdk } = fixture();
      sdk.mockImplementation(
        async () =>
          new Response("PRIVATE", {
            status: sdkStatus,
            headers: {
              "set-cookie": "renewed=1",
              "cache-control": "public",
              location: "https://evil.invalid",
            },
          }),
      );
      const response = await handlers.signIn(request(mutations[0][1]));
      expect(response.headers.getSetCookie()).toEqual(["renewed=1"]);
      expect(response.headers.has("location")).toBe(false);
      await error(response, status, code);
    });
  it("preserves helper cookies after denial and hides raw error fields", async () => {
    const { handlers, sessions } = fixture();
    sessions.switchOrganization.mockImplementation(async (input?: unknown) => {
      const args = input as { responseHeaders: Headers };
      args.responseHeaders.append("set-cookie", "renewal=1");
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "PRIVATE",
          correlationId: "PRIVATE",
          retryable: false,
          fields: { PRIVATE: ["PRIVATE"] },
        },
      } as never;
    });
    const response = await handlers.selectOrganization(
      request({ organizationId: "org-a" }),
    );
    expect(response.headers.getSetCookie()).toEqual(["renewal=1"]);
    await error(response, 403, "FORBIDDEN");
  });
  it("uses fixed reset destination and server correlation, no forwarded authority", async () => {
    const { handlers, sessions } = fixture();
    await handlers.requestReset(
      request(
        { email: "synthetic@example.invalid" },
        { "x-forwarded-host": "evil.invalid" },
      ),
    );
    expect(sessions.requestPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "synthetic@example.invalid",
        redirectTo: `${appUrl}/reset-password`,
        correlationId: expect.any(String),
      }),
    );
  });
  it("catches unexpected dependency errors without disclosure", async () => {
    const { handlers, sdk } = fixture();
    sdk.mockRejectedValue(new Error("PRIVATE"));
    await error(
      await handlers.signIn(request(mutations[0][1])),
      503,
      "DEPENDENCY_UNAVAILABLE",
    );
  });
  it("projects only current choices and discards stale selection", async () => {
    const { handlers, getSession } = fixture();
    const result = await handlers.organizations(request(undefined, {}, "GET"));
    expect(await result.json()).toEqual({
      ok: true,
      value: { currentOrganizationId: "org-a", options: [option] },
    });
    getSession.mockResolvedValue({
      headers: new Headers(),
      response: {
        user: { id: "verified" },
        session: { activeOrganizationId: "revoked" },
      },
    });
    expect(
      await (
        await handlers.organizations(request(undefined, {}, "GET"))
      ).json(),
    ).toEqual({
      ok: true,
      value: { currentOrganizationId: null, options: [option] },
    });
  });
  it("denies absent session and preserves renewal before later membership failure", async () => {
    const { handlers, getSession, sessions } = fixture();
    getSession.mockResolvedValue({
      headers: new Headers({ "set-cookie": "renewed=1" }),
      response: null,
    } as never);
    await error(
      await handlers.organizations(request(undefined, {}, "GET")),
      401,
      "UNAUTHENTICATED",
    );
    getSession.mockResolvedValue({
      headers: new Headers({ "set-cookie": "renewed=1" }),
      response: {
        user: { id: "verified" },
        session: { activeOrganizationId: "org-a" },
      },
    });
    sessions.listAvailableOrganizations.mockRejectedValue(new Error("PRIVATE"));
    const response = await handlers.organizations(
      request(undefined, {}, "GET"),
    );
    expect(response.headers.getSetCookie()).toEqual(["renewed=1"]);
    await error(response, 503, "DEPENDENCY_UNAVAILABLE");
  });
});
