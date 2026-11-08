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
  type Result,
} from "@relay/contracts";
import type { Auth, SessionResolver } from "../auth/index.ts";

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
  >;
}
const status: Record<Code, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
};
const messages: Record<Code, string> = {
  UNAUTHENTICATED: "Sign-in is required",
  FORBIDDEN: "Request is not permitted",
  NOT_FOUND: "Resource was not found",
  VALIDATION: "Request cannot be completed",
  CONFLICT: "Request conflicts with current state",
  RATE_LIMITED: "Try again later",
  DEPENDENCY_UNAVAILABLE: "Authentication service is unavailable",
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
}: AuthHttpDependencies) {
  const origin = new URL(appUrl).origin;
  type Call = { request: Request; headers: Headers; correlationId: string };
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
      sdk(
        auth.api.signInEmail({
          body: input,
          headers: call.request.headers,
          asResponse: true,
        }),
        call,
      ),
    ),
    signUp: mutation(authSignUpCommandSchema, (input, call) =>
      sdk(
        auth.api.signUpEmail({
          body: input,
          headers: call.request.headers,
          asResponse: true,
        }),
        call,
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
    requestReset: mutation(authResetRequestSchema, (input, call) =>
      sessions.requestPasswordReset({
        ...input,
        ...helper(call),
        redirectTo: new URL("/reset-password", origin).toString(),
      }),
    ),
    confirmReset: mutation(authResetConfirmSchema, (input, call) =>
      sessions.resetPassword({ ...input, correlationId: call.correlationId }),
    ),
    requestVerification: mutation(
      authVerificationRequestSchema,
      (input, call) =>
        sessions.requestEmailVerification({ ...input, ...helper(call) }),
    ),
    confirmVerification: mutation(
      authVerificationConfirmSchema,
      (input, call) =>
        sessions.confirmEmailVerification({ ...input, ...helper(call) }),
    ),
    acceptInvitation: mutation(authInvitationAcceptanceSchema, (input, call) =>
      sessions.acceptInvitation({ ...input, ...helper(call) }),
    ),
    selectOrganization: mutation(
      authOrganizationSelectionSchema,
      (input, call) =>
        sessions.switchOrganization({ ...input, ...helper(call) }),
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
