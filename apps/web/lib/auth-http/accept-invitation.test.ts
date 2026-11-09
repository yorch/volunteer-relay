import { describe, expect, it, vi } from "vitest";
import { type AuthHttpDependencies, createAuthHttpHandlers } from "./index.ts";

// Controlled resolver: the HTTP layer maps each acceptance code to one fixed
// status and body and never forwards resolver text.
const appUrl = "http://localhost:3186";

function accept(code: string) {
  const acceptInvitation = vi.fn(async () => ({
    ok: false as const,
    error: {
      code,
      message: "PRIVATE resolver detail",
      correlationId: "resolver-correlation",
      retryable: true,
    },
  }));
  const handlers = createAuthHttpHandlers({
    appUrl,
    auth: { api: {} },
    sessions: { acceptInvitation },
  } as unknown as AuthHttpDependencies);
  return handlers.acceptInvitation(
    new Request(`${appUrl}/api/auth/invitations/accept`, {
      method: "POST",
      headers: { origin: appUrl, "content-type": "application/json" },
      body: JSON.stringify({ invitationId: "synthetic-invitation" }),
    }),
  );
}

describe("POST /api/auth/invitations/accept error mapping", () => {
  it.each([
    ["EMAIL_NOT_VERIFIED", 403, "Email verification is required"],
    ["INVITATION_EXPIRED", 410, "Invitation has expired"],
    ["NOT_AVAILABLE", 404, "Invitation is not available"],
    ["UNAUTHENTICATED", 401, "Sign-in is required"],
  ])(
    "%s maps to %i with fixed, non-retryable no-store text",
    async (code, status, message) => {
      const response = await accept(code);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({
        ok: false,
        error: {
          code,
          message,
          correlationId: expect.any(String),
          retryable: false,
        },
      });
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE|resolver-correlation/);
    },
  );
});
