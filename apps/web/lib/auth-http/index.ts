import { randomUUID } from "node:crypto";
import {
  type ApiError,
  authInvitationAcceptanceSchema,
  authOrganizationChoicesSchema,
  authOrganizationSelectionSchema,
  authResetConfirmSchema,
  authResetRequestSchema,
  authSignInCommandSchema,
  authSignUpCommandSchema,
  authVerificationConfirmSchema,
  authVerificationRequestSchema,
  errorCodeHttpStatus,
  type Result,
} from "@relay/contracts";
import type { Auth, SessionResolver } from "../auth/index.ts";
import {
  accountKey,
  createRateLimiter,
  clientAddress as forwardedClientAddress,
  type RateLimiter,
  type RateRule,
} from "./rate-limit.ts";

type Code = ApiError["error"]["code"];
export interface AuthHttpDependencies {
  appUrl: string;
  auth: {
    api: Pick<
      Auth["api"],
      "signInEmail" | "signUpEmail" | "signOut" | "getSession"
    >;
  };
  sessions: Pick<
    SessionResolver,
    | "requestPasswordReset"
    | "resetPassword"
    | "requestEmailVerification"
    | "confirmEmailVerification"
    | "acceptInvitation"
    | "switchOrganization"
    | "listAvailableOrganizations"
    | "listPendingInvitations"
  >;
  // Defaults to one in-memory limiter per handler set; see rate-limit.ts for
  // the single-replica and trusted-proxy assumptions.
  rateLimiter?: RateLimiter;
  clientAddress?: (request: Request) => string;
  rateRules?: Partial<AuthRateRules>;
}

const minute = 60_000;
/**
 * Application-level limits. Routes call Better Auth through `auth.api`, which
 * bypasses the library's own HTTP rate limiter, so these are the only limits.
 * Sign-in and token confirmation count attempts and refund successes, so a
 * burst cannot outrun failure counting; mail-sending requests count every
 * attempt because each one may deliver a message.
 */
export const defaultAuthRateRules = {
  signInPerAccount: { limit: 10, windowMs: 15 * minute },
  signInPerAddress: { limit: 50, windowMs: 15 * minute },
  signUpPerAccount: { limit: 5, windowMs: 60 * minute },
  signUpPerAddress: { limit: 20, windowMs: 60 * minute },
  mailRequestPerAccount: { limit: 5, windowMs: 60 * minute },
  mailRequestPerAddress: { limit: 30, windowMs: 60 * minute },
  tokenConfirmPerAddress: { limit: 30, windowMs: 15 * minute },
  // A read, counted per attempt: the zero-organization panel loads it once.
  invitationListPerAddress: { limit: 60, windowMs: 15 * minute },
} satisfies Record<string, RateRule>;
export type AuthRateRules = typeof defaultAuthRateRules;
const status: Record<Code, number> = errorCodeHttpStatus;
// Fixed per-code text: a response body is a function of its code alone, so two
// failures with the same code are indistinguishable apart from correlationId.
const messages: Record<Code, string> = {
  UNAUTHENTICATED: "Sign-in is required",
  FORBIDDEN: "Request is not permitted",
  NOT_FOUND: "Resource was not found",
  VALIDATION: "Request cannot be completed",
  CONFLICT: "Request conflicts with current state",
  RATE_LIMITED: "Try again later",
  DEPENDENCY_UNAVAILABLE: "Authentication service is unavailable",
  EMAIL_NOT_VERIFIED: "Email verification is required",
  INVITATION_EXPIRED: "Invitation has expired",
  NOT_AVAILABLE: "Invitation is not available",
};
function failure(code: Code, correlationId: string): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: messages[code],
      correlationId,
      retryable: code === "DEPENDENCY_UNAVAILABLE" || code === "RATE_LIMITED",
    },
  };
}
function collect(source: Headers, target: Headers) {
  for (const [key, value] of source)
    if (key.toLowerCase() !== "set-cookie") target.set(key, value);
  for (const cookie of source.getSetCookie())
    target.append("set-cookie", cookie);
}
function reply(
  result: Result<unknown>,
  headers: Headers,
  correlationId: string,
) {
  // SDK/business error detail is never part of the transport response.
  const safe = result.ok ? result : failure(result.error.code, correlationId);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  // Body framing belongs to this response, not the SDK response we replaced.
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("location");
  return new Response(JSON.stringify(safe), {
    status: safe.ok ? 200 : status[safe.error.code],
    headers,
  });
}
function sdkCode(code: number): Code {
  if (code === 401) return "UNAUTHENTICATED";
  if (code === 403) return "FORBIDDEN";
  if (code === 404) return "NOT_FOUND";
  if (code === 409) return "CONFLICT";
  if (code === 429) return "RATE_LIMITED";
  return code >= 500 ? "DEPENDENCY_UNAVAILABLE" : "VALIDATION";
}
async function body(request: Request): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new Error("body");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
export function createAuthHttpHandlers({
  appUrl,
  auth,
  sessions,
  rateLimiter = createRateLimiter(),
  clientAddress = forwardedClientAddress,
  rateRules,
}: AuthHttpDependencies) {
  const origin = new URL(appUrl).origin;
  const rules: AuthRateRules = { ...defaultAuthRateRules, ...rateRules };
  type Call = { request: Request; headers: Headers; correlationId: string };
  type Limit = { key: string; rule: RateRule };
  // Checks every limit before counting any, so a denied request does not
  // extend its own lockout; refunds apply only to a successful result.
  async function limited(
    call: Call,
    limits: Limit[],
    refundOnSuccess: boolean,
    run: () => Promise<Result<unknown>>,
  ): Promise<Result<unknown>> {
    for (const { key, rule } of limits) {
      const retryAfter = rateLimiter.blocked(key, rule);
      if (retryAfter !== null) {
        call.headers.set("retry-after", String(retryAfter));
        return failure("RATE_LIMITED", call.correlationId);
      }
    }
    for (const { key, rule } of limits) rateLimiter.hit(key, rule);
    const result = await run();
    if (result.ok && refundOnSuccess)
      for (const { key } of limits) rateLimiter.release(key);
    return result;
  }
  const byAddress = (scope: string, call: Call, rule: RateRule): Limit => ({
    key: `${scope}:address:${clientAddress(call.request)}`,
    rule,
  });
  const byAccount = (scope: string, email: string, rule: RateRule): Limit => ({
    key: `${scope}:account:${accountKey(email)}`,
    rule,
  });
  function handler(
    method: "GET" | "POST",
    run: (call: Call) => Promise<Result<unknown>>,
  ) {
    return async (request: Request): Promise<Response> => {
      const headers = new Headers();
      const correlationId = randomUUID();
      if (request.method !== method)
        return reply(
          failure("VALIDATION", correlationId),
          headers,
          correlationId,
        );
      if (method === "POST" && request.headers.get("origin") !== origin)
        return reply(
          failure("FORBIDDEN", correlationId),
          headers,
          correlationId,
        );
      try {
        return reply(
          await run({ request, headers, correlationId }),
          headers,
          correlationId,
        );
      } catch {
        return reply(
          failure("DEPENDENCY_UNAVAILABLE", correlationId),
          headers,
          correlationId,
        );
      }
    };
  }
  function mutation<T>(
    schema: {
      safeParse: (
        v: unknown,
      ) => { success: true; data: T } | { success: false };
    },
    run: (input: T, call: Call) => Promise<Result<unknown>>,
  ) {
    return handler("POST", async (call) => {
      let input: unknown;
      try {
        input = await body(call.request);
      } catch {
        return failure("VALIDATION", call.correlationId);
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success) return failure("VALIDATION", call.correlationId);
      const result = await run(parsed.data, call);
      return result.ok ? { ok: true, value: undefined } : result;
    });
  }
  async function sdk(
    response: Promise<Response>,
    call: Call,
  ): Promise<Result<void>> {
    const result = await response;
    collect(result.headers, call.headers);
    return result.ok
      ? { ok: true, value: undefined }
      : failure(sdkCode(result.status), call.correlationId);
  }
  const helper = (call: Call) => ({
    headers: call.request.headers,
    responseHeaders: call.headers,
    correlationId: call.correlationId,
  });
  return {
    signIn: mutation(authSignInCommandSchema, (input, call) =>
      limited(
        call,
        [
          byAccount("sign-in", input.email, rules.signInPerAccount),
          byAddress("sign-in", call, rules.signInPerAddress),
        ],
        true,
        () =>
          sdk(
            auth.api.signInEmail({
              body: input,
              headers: call.request.headers,
              asResponse: true,
            }),
            call,
          ),
      ),
    ),
    signUp: mutation(authSignUpCommandSchema, (input, call) =>
      limited(
        call,
        [
          byAccount("sign-up", input.email, rules.signUpPerAccount),
          byAddress("sign-up", call, rules.signUpPerAddress),
        ],
        false,
        async () => {
          const created = await sdk(
            auth.api.signUpEmail({
              body: input,
              headers: call.request.headers,
              asResponse: true,
            }),
            call,
          );
          if (!created.ok) return created;
          // The account exists whether or not this send succeeds, so the
          // failure is never surfaced and never turns a created account into a
          // failed sign-up: the recipient can request a fresh link at
          // /verify-email. Without this call nothing is sent at all, because
          // the SDK has no sendOnSignUp wiring.
          const verification = await sessions.requestEmailVerification({
            email: input.email,
            ...helper(call),
          });
          // A missing mail callback and a failed token insert both return here
          // and never reach the delivery warning, which would leave an account
          // with no verification row and no operator signal. `code` is a
          // closed union, not transport text.
          if (!verification.ok)
            console.warn("auth.signup.verification_unavailable", {
              code: verification.error.code,
            });
          return created;
        },
      ),
    ),
    signOut: mutation(
      {
        safeParse: (v: unknown) =>
          v !== null &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          Object.keys(v).length === 0
            ? { success: true as const, data: {} }
            : { success: false as const },
      },
      (_input, call) =>
        sdk(
          auth.api.signOut({ headers: call.request.headers, asResponse: true }),
          call,
        ),
    ),
    // Reset and verification requests share one per-account budget: both
    // send mail to the same address. The denial is identical for known and
    // unknown accounts, so it does not enumerate.
    requestReset: mutation(authResetRequestSchema, (input, call) =>
      limited(
        call,
        [
          byAccount("mail", input.email, rules.mailRequestPerAccount),
          byAddress("mail", call, rules.mailRequestPerAddress),
        ],
        false,
        () =>
          sessions.requestPasswordReset({
            ...input,
            ...helper(call),
            redirectTo: new URL("/reset-password", origin).toString(),
          }),
      ),
    ),
    confirmReset: mutation(authResetConfirmSchema, (input, call) =>
      limited(
        call,
        [byAddress("token", call, rules.tokenConfirmPerAddress)],
        true,
        () =>
          sessions.resetPassword({
            ...input,
            correlationId: call.correlationId,
          }),
      ),
    ),
    requestVerification: mutation(
      authVerificationRequestSchema,
      (input, call) =>
        limited(
          call,
          [
            byAccount("mail", input.email, rules.mailRequestPerAccount),
            byAddress("mail", call, rules.mailRequestPerAddress),
          ],
          false,
          () =>
            sessions.requestEmailVerification({ ...input, ...helper(call) }),
        ),
    ),
    confirmVerification: mutation(
      authVerificationConfirmSchema,
      (input, call) =>
        limited(
          call,
          [byAddress("token", call, rules.tokenConfirmPerAddress)],
          true,
          () =>
            sessions.confirmEmailVerification({ ...input, ...helper(call) }),
        ),
    ),
    acceptInvitation: mutation(authInvitationAcceptanceSchema, (input, call) =>
      sessions.acceptInvitation({ ...input, ...helper(call) }),
    ),
    selectOrganization: mutation(
      authOrganizationSelectionSchema,
      (input, call) =>
        sessions.switchOrganization({ ...input, ...helper(call) }),
    ),
    // Same-origin GET read like `organizations`; the recipient is the verified
    // session, and the resolver returns only that user's own invitations.
    invitations: handler("GET", (call) =>
      limited(
        call,
        [byAddress("invitations", call, rules.invitationListPerAddress)],
        false,
        () => sessions.listPendingInvitations(helper(call)),
      ),
    ),
    organizations: handler("GET", async (call) => {
      const current = await auth.api.getSession({
        headers: call.request.headers,
        returnHeaders: true,
      });
      collect(current.headers, call.headers);
      if (!current.response?.user.id)
        return failure("UNAUTHENTICATED", call.correlationId);
      const options = await sessions.listAvailableOrganizations(helper(call));
      if (!options.ok) return options;
      const selected = current.response.session.activeOrganizationId;
      const parsed = authOrganizationChoicesSchema.safeParse({
        options: options.value,
        currentOrganizationId: options.value.some(
          (o) => o.organizationId === selected,
        )
          ? selected
          : null,
      });
      if (!parsed.success)
        return failure("DEPENDENCY_UNAVAILABLE", call.correlationId);
      return { ok: true, value: parsed.data };
    }),
  };
}
