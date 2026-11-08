import { describe, expect, it, vi } from "vitest";
import { type AuthHttpDependencies, createAuthHttpHandlers } from "./index.ts";

const appUrl = "http://localhost:3186";
const credentials = {
  name: "Synthetic Person",
  email: "synthetic@example.invalid",
  password: "correct horse battery staple",
};

type VerificationOutcome =
  | { ok: true; value: undefined }
  | {
      ok: false;
      error: {
        code: "DEPENDENCY_UNAVAILABLE";
        message: string;
        correlationId: string;
        retryable: boolean;
      };
    };

function fixture(
  sdkResponse: () => Promise<Response> = async () =>
    new Response("{}", { status: 200 }),
) {
  const signUpEmail = vi.fn(sdkResponse);
  const requestEmailVerification = vi.fn(
    async (_input: {
      email: string;
      correlationId: string;
    }): Promise<VerificationOutcome> => ({ ok: true, value: undefined }),
  );
  const dependencies = {
    appUrl,
    auth: {
      api: {
        signInEmail: vi.fn(),
        signUpEmail,
        signOut: vi.fn(),
        getSession: vi.fn(),
      },
    },
    sessions: {
      requestPasswordReset: vi.fn(),
      resetPassword: vi.fn(),
      requestEmailVerification,
      confirmEmailVerification: vi.fn(),
      acceptInvitation: vi.fn(),
      switchOrganization: vi.fn(),
      listAvailableOrganizations: vi.fn(),
    },
  } as unknown as AuthHttpDependencies;
  const handlers = createAuthHttpHandlers(dependencies);
  const signUp = (headers: Record<string, string> = {}) =>
    handlers.signUp(
      new Request(`${appUrl}/api/auth/sign-up`, {
        method: "POST",
        headers: {
          origin: appUrl,
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(credentials),
      }),
    );
  return { signUp, signUpEmail, requestEmailVerification };
}

// Sign-up creates the account through the SDK, which has no sendOnSignUp
// wiring of its own. Without an explicit request the recipient never receives a
// verification link, and an unverified account cannot accept an invitation.
describe("sign-up sends the verification email", () => {
  it("requests verification for the address that was just registered", async () => {
    const { signUp, requestEmailVerification } = fixture();
    const response = await signUp();
    expect(response.status).toBe(200);
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
    expect(requestEmailVerification.mock.calls[0]?.[0]).toMatchObject({
      email: credentials.email,
      correlationId: expect.any(String),
    });
  });

  it("does not request verification when registration itself failed", async () => {
    const { signUp, requestEmailVerification } = fixture(
      async () => new Response("{}", { status: 409 }),
    );
    const response = await signUp();
    expect(response.status).toBe(409);
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });

  // A delivery failure must not undo a created account: the row is valid and
  // the recipient can request a fresh link at /verify-email.
  it("still reports success when delivery is unavailable", async () => {
    const { signUp, requestEmailVerification } = fixture();
    requestEmailVerification.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Email verification delivery is not configured",
        correlationId: "synthetic",
        retryable: true,
      },
    });
    const response = await signUp();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    // Proves the attempt happened and its failure was consumed, rather than the
    // call having been dropped and the test passing for the wrong reason.
    expect(requestEmailVerification).toHaveBeenCalledTimes(1);
    expect(requestEmailVerification.mock.calls[0]?.[0]).toMatchObject({
      email: credentials.email,
    });
  });

  // The origin guard runs before anything else, so a cross-site POST cannot
  // create an account or trigger a send.
  it("refuses a cross-origin sign-up without sending anything", async () => {
    const { signUp, signUpEmail, requestEmailVerification } = fixture();
    const response = await signUp({ origin: "https://attacker.example" });
    expect(response.status).toBe(403);
    expect(signUpEmail).not.toHaveBeenCalled();
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });
});
