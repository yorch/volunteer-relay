import { describe, expect, it, vi } from "vitest";
import type { Auth } from "./auth.ts";
import { createSessionResolver } from "./session.ts";

// Database-free: a controlled stand-in for the Better Auth API surface that
// acceptance reads. Every row is synthetic.
const now = new Date("2026-03-01T12:00:00.000Z");
const hour = 60 * 60 * 1000;
const recipient = "Recipient@Example.invalid";

type Row = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  organizationName: string;
};
const row = (overrides: Partial<Row> = {}): Row => ({
  id: "own-invitation",
  email: recipient.toLowerCase(),
  role: "volunteer",
  status: "pending",
  expiresAt: new Date(now.getTime() + hour),
  organizationName: "Synthetic Garden",
  ...overrides,
});

function fixture(
  input: {
    user?: { id: string; email: string; emailVerified: boolean } | null;
    rows?: Row[];
    sessionFails?: boolean;
    listFails?: boolean;
    acceptFails?: boolean;
  } = {},
) {
  const user =
    input.user === undefined
      ? { id: "user-recipient", email: recipient, emailVerified: true }
      : input.user;
  const getSession = vi.fn(async () => {
    if (input.sessionFails) throw new Error("session store down");
    return { headers: new Headers(), response: user ? { user } : null };
  });
  const listUserInvitations = vi.fn(async () => {
    if (input.listFails) throw new Error("adapter down");
    return input.rows ?? [row()];
  });
  const acceptInvitation = vi.fn(async () => {
    if (input.acceptFails) throw new Error("library refused");
    return {
      headers: new Headers(),
      response: {
        member: { userId: "user-recipient" },
        invitation: { organizationId: "org-synthetic" },
      },
    };
  });
  const auth = {
    api: { getSession, listUserInvitations, acceptInvitation },
  } as unknown as Auth;
  const resolver = createSessionResolver({
    auth,
    authorization: {} as never,
    memberships: {} as never,
    appUrl: "http://localhost:3186",
    mailConfigured: true,
  });
  const run = (invitationId = "own-invitation") =>
    resolver.acceptInvitation({
      headers: new Headers(),
      invitationId,
      correlationId: "corr",
      now,
    });
  return { run, getSession, listUserInvitations, acceptInvitation };
}

const code = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? "OK" : result.error?.code;

describe("invitation acceptance classification", () => {
  it("accepts the verified recipient's own pending invitation", async () => {
    const { run, acceptInvitation } = fixture();
    expect(await run()).toEqual({
      ok: true,
      value: { organizationId: "org-synthetic" },
    });
    expect(acceptInvitation).toHaveBeenCalledOnce();
  });

  it("asks for sign-in without a session", async () => {
    const { run, listUserInvitations } = fixture({ user: null });
    expect(code(await run())).toBe("UNAUTHENTICATED");
    expect(listUserInvitations).not.toHaveBeenCalled();
  });

  it("refuses an unverified caller before any invitation lookup", async () => {
    for (const invitationId of ["own-invitation", "missing"]) {
      const { run, listUserInvitations, acceptInvitation } = fixture({
        user: { id: "user-recipient", email: recipient, emailVerified: false },
      });
      expect(code(await run(invitationId))).toBe("EMAIL_NOT_VERIFIED");
      expect(listUserInvitations).not.toHaveBeenCalled();
      expect(acceptInvitation).not.toHaveBeenCalled();
    }
  });

  it("reports expiry only for the caller's own pending invitation", async () => {
    const { run, acceptInvitation } = fixture({
      rows: [row({ expiresAt: new Date(now.getTime() - 1) })],
    });
    expect(code(await run())).toBe("INVITATION_EXPIRED");
    expect(acceptInvitation).not.toHaveBeenCalled();
    // Expiring exactly now is expired, matching the pending-list projection.
    const boundary = fixture({ rows: [row({ expiresAt: now })] });
    expect(code(await boundary.run())).toBe("INVITATION_EXPIRED");
  });

  it("answers unknown, foreign, used and canceled invitations identically", async () => {
    const cases = [
      fixture({ rows: [] }).run("missing"),
      // A row for another email cannot come back for this session, but the
      // resolver refuses it anyway, and refuses it the same way.
      fixture({ rows: [row({ email: "other@example.invalid" })] }).run(),
      fixture({ rows: [row({ status: "accepted" })] }).run(),
      fixture({ rows: [row({ status: "canceled" })] }).run(),
      // An expired invitation addressed to someone else is not this caller's.
      fixture({
        rows: [
          row({
            email: "other@example.invalid",
            expiresAt: new Date(now.getTime() - hour),
          }),
        ],
      }).run(),
    ];
    const results = await Promise.all(cases);
    for (const result of results)
      expect(result).toEqual({
        ok: false,
        error: {
          code: "NOT_AVAILABLE",
          message: "Invitation is not available",
          correlationId: "corr",
          retryable: false,
        },
      });
  });

  it("maps a library refusal after the checks to NOT_AVAILABLE", async () => {
    const { run } = fixture({ acceptFails: true });
    expect(code(await run())).toBe("NOT_AVAILABLE");
  });

  it("reports dependency failures as retryable and never as a denial", async () => {
    for (const failing of [{ sessionFails: true }, { listFails: true }]) {
      const result = await fixture(failing).run();
      expect(result).toMatchObject({
        ok: false,
        error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
      });
    }
  });
});
