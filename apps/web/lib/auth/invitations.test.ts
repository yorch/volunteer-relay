import { describe, expect, it, vi } from "vitest";
import type { Auth } from "./auth.ts";
import { createSessionResolver } from "./session.ts";

const now = new Date("2026-03-01T12:00:00.000Z");
const hour = 60 * 60 * 1000;
const recipient = "recipient@example.invalid";
const later = (hours: number) => new Date(now.getTime() + hours * hour);

function row(
  id: string,
  overrides: Partial<{
    email: string;
    role: string;
    status: string;
    expiresAt: Date;
    organizationName: string;
  }> = {},
) {
  return {
    id,
    email: recipient,
    role: "volunteer",
    status: "pending",
    expiresAt: later(24),
    organizationId: `org-${id}`,
    organizationName: `Synthetic ${id}`,
    inviterId: "inviter-PRIVATE",
    teamId: null,
    createdAt: now,
    ...overrides,
  };
}

function fixture(user: { emailVerified: boolean } | null) {
  const getSession = vi.fn(async () => ({
    headers: new Headers({ "set-cookie": "renewed=1" }),
    response: user
      ? {
          user: { id: "user-a", email: recipient, ...user },
          session: { activeOrganizationId: null },
        }
      : null,
  }));
  const listUserInvitations = vi.fn(async (): Promise<unknown[]> => []);
  const resolver = createSessionResolver({
    auth: { api: { getSession, listUserInvitations } } as unknown as Auth,
    authorization: { resolve: vi.fn() } as never,
    memberships: { listMembershipsForUser: vi.fn() } as never,
    appUrl: "http://localhost:3186",
    mailConfigured: true,
  });
  const headers = new Headers({ cookie: "session=synthetic" });
  const responseHeaders = new Headers();
  const list = () =>
    resolver.listPendingInvitations({
      headers,
      responseHeaders,
      correlationId: "correlation",
      now,
    });
  return { getSession, listUserInvitations, list, headers, responseHeaders };
}

describe("pending invitations for the session recipient", () => {
  it("requires a session and never looks up invitations without one", async () => {
    const { list, listUserInvitations } = fixture(null);
    const result = await list();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHENTICATED");
    expect(listUserInvitations).not.toHaveBeenCalled();
  });

  it("answers an unverified email with only its own verification state", async () => {
    const { list, listUserInvitations, responseHeaders } = fixture({
      emailVerified: false,
    });
    listUserInvitations.mockResolvedValue([row("hidden")]);
    expect(await list()).toEqual({
      ok: true,
      value: { emailVerified: false, invitations: [] },
    });
    expect(listUserInvitations).not.toHaveBeenCalled();
    expect(responseHeaders.getSetCookie()).toEqual(["renewed=1"]);
  });

  it("lists only pending, unexpired, contract-role invitations for this email", async () => {
    const { list, listUserInvitations, headers } = fixture({
      emailVerified: true,
    });
    listUserInvitations.mockResolvedValue([
      row("later", { expiresAt: later(40), role: "coordinator" }),
      row("expired", { expiresAt: later(-1) }),
      row("expiring-now", { expiresAt: now }),
      row("foreign", { email: "someone-else@example.invalid" }),
      row("accepted", { status: "accepted" }),
      row("rejected", { status: "rejected" }),
      row("admin", { role: "admin" }),
      row("sooner", {
        email: "Recipient@Example.INVALID",
        expiresAt: later(2),
      }),
    ]);
    const result = await list();
    expect(result).toEqual({
      ok: true,
      value: {
        emailVerified: true,
        invitations: [
          {
            invitationId: "sooner",
            organizationName: "Synthetic sooner",
            role: "volunteer",
            expiresAt: "2026-03-01T14:00:00.000Z",
          },
          {
            invitationId: "later",
            organizationName: "Synthetic later",
            role: "coordinator",
            expiresAt: "2026-03-03T04:00:00.000Z",
          },
        ],
      },
    });
    // The library is asked with the caller's own session, never an email.
    expect(listUserInvitations).toHaveBeenCalledWith({ headers });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE|org-|someone-else|recipient@/i,
    );
  });

  it("caps the list at 20 with a deterministic order", async () => {
    const { list, listUserInvitations } = fixture({ emailVerified: true });
    // 25 rows in reverse order; ties on expiry break by invitation id.
    const rows = Array.from({ length: 25 }, (_, index) =>
      row(`inv-${String(24 - index).padStart(2, "0")}`, {
        expiresAt: later(1 + Math.floor((24 - index) / 2)),
      }),
    );
    listUserInvitations.mockResolvedValue(rows);
    const result = await list();
    if (!result.ok) throw new Error("expected a list");
    expect(result.value.invitations.map((item) => item.invitationId)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `inv-${String(index).padStart(2, "0")}`,
      ),
    );
  });

  it("reports an unavailable lookup without detail", async () => {
    const { list, listUserInvitations } = fixture({ emailVerified: true });
    listUserInvitations.mockRejectedValue(new Error("PRIVATE driver detail"));
    const result = await list();
    expect(result).toEqual({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Invitation lookup is unavailable",
        correlationId: "correlation",
        retryable: true,
      },
    });
  });
});
