import { randomUUID } from "node:crypto";
import {
  type ApiError,
  errorCodeHttpStatus,
  operatorCreateOrganizationCommandSchema,
  operatorMemberRoleCommandSchema,
  operatorOrganizationDetailQuerySchema,
  operatorOrganizationQuerySchema,
  type Result,
} from "@relay/contracts";
import type { RateLimiter, RateRule } from "../auth-http/rate-limit.ts";
import type { OperatorIdentity } from "./accounts.ts";
import type { OperatorService } from "./service.ts";

/**
 * A global mutation re-authenticates recently: an old session left open on a
 * shared machine cannot quietly re-grant ownership. Sessions live 7 days, so
 * this is the only freshness bound in the product.
 */
export const OPERATOR_SESSION_MAX_AGE_MS = 30 * 60 * 1000;
export const OPERATOR_BODY_LIMIT = 8 * 1024;
const minute = 60_000;
export const defaultOperatorRateRules: Record<"read" | "write", RateRule> = {
  read: { limit: 120, windowMs: 15 * minute },
  write: { limit: 20, windowMs: 60 * minute },
};

export interface OperatorSessionActor extends OperatorIdentity {
  /** Creation time of the verified session that authorized this request. */
  sessionCreatedAt: Date;
}

export interface OperatorHttpDependencies {
  appUrl: string;
  /**
   * Resolves operator authority from a verified session. Never organization
   * scoped: this surface has no tenant context at all.
   */
  resolve(
    request: Request,
    responseHeaders: Headers,
  ): Promise<Result<OperatorSessionActor>>;
  service: OperatorService;
  rateLimiter?: RateLimiter;
  rateRules?: Record<"read" | "write", RateRule>;
  now?: () => Date;
  bodyLimit?: number;
}

const status = errorCodeHttpStatus as Record<string, number>;
const message = {
  UNAUTHENTICATED: "Sign in to continue",
  FORBIDDEN: "This action is not permitted",
  NOT_FOUND: "Resource was not found",
  VALIDATION: "Check the submitted fields",
  CONFLICT: "The record changed. Refresh and try again",
  RATE_LIMITED: "Try again later",
  DEPENDENCY_UNAVAILABLE: "The service is temporarily unavailable",
  EMAIL_NOT_VERIFIED: "Verify your email to continue",
  INVITATION_EXPIRED: "This invitation has expired",
  NOT_AVAILABLE: "Resource is not available",
} satisfies Record<ApiError["error"]["code"], string>;

function failure(
  code: ApiError["error"]["code"],
  correlationId: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: message[code],
      correlationId,
      retryable: code === "DEPENDENCY_UNAVAILABLE" || code === "RATE_LIMITED",
    },
  };
}

async function readBoundedJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("body");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * HTTP transport for the platform operator console. Deliberately separate from
 * `createProductHandler`: this handler has no `TenantContext`, no organizations
 * resolved from a session and no product extensions, so no tenant code path can
 * be reached with cross-organization authority (see the boundary test).
 *
 * Every request that is not a live, configured operator is answered with
 * NOT_FOUND, so the console's existence is not an account oracle. Dependency
 * failures stay distinguishable so an operator does not read an outage as a
 * permission problem.
 */
export function createOperatorHandler(deps: OperatorHttpDependencies) {
  const rules = deps.rateRules ?? defaultOperatorRateRules;
  const limit = deps.bodyLimit ?? OPERATOR_BODY_LIMIT;
  const now = deps.now ?? (() => new Date());
  return async (request: Request): Promise<Response> => {
    const correlationId = randomUUID();
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const reply = (result: Result<unknown>, code?: ApiError["error"]["code"]) =>
      Response.json(
        result.ok ? result : failure(code ?? result.error.code, correlationId),
        {
          status: result.ok ? 200 : (status[code ?? result.error.code] ?? 503),
          headers,
        },
      );
    try {
      const resolved = await deps.resolve(request, headers);
      // A refusal is indistinguishable from "this surface is not configured".
      if (!resolved.ok)
        return reply(
          failure(
            resolved.error.code === "DEPENDENCY_UNAVAILABLE"
              ? "DEPENDENCY_UNAVAILABLE"
              : "NOT_FOUND",
            correlationId,
          ),
        );
      // Checked only after authority resolves: an unauthenticated request to an
      // unsupported method must look exactly like any other refusal, not like a
      // configured surface.
      if (!["GET", "POST"].includes(request.method))
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, POST", "cache-control": "no-store" },
        });
      const actor = resolved.value;
      const write = request.method === "POST";
      if (
        write &&
        request.headers.get("origin") !== new URL(deps.appUrl).origin
      )
        return reply(failure("FORBIDDEN", correlationId));
      if (write) {
        const age = now().getTime() - actor.sessionCreatedAt.getTime();
        if (!Number.isFinite(age) || age > OPERATOR_SESSION_MAX_AGE_MS)
          return reply(failure("FORBIDDEN", correlationId));
      }
      if (deps.rateLimiter) {
        // Separate buckets per class: a read burst must not consume the
        // mutation budget, and both stay per operator rather than per address.
        const key = `operator:${write ? "write" : "read"}:${actor.userId}`;
        const rule = write ? rules.write : rules.read;
        const retryAfter = deps.rateLimiter.blocked(key, rule);
        if (retryAfter !== null)
          return Response.json(failure("RATE_LIMITED", correlationId), {
            status: status.RATE_LIMITED ?? 429,
            headers: {
              ...Object.fromEntries(headers),
              "retry-after": String(retryAfter),
            },
          });
        deps.rateLimiter.hit(key, rule);
      }
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/operator\/?/, "");
      const parameters = [...url.searchParams.keys()];
      if (request.method === "GET" && path === "session")
        return reply({ ok: true, value: { operator: true } });
      if (request.method === "GET" && path === "organizations") {
        if (parameters.some((key) => !["q", "cursor"].includes(key)))
          return reply(failure("VALIDATION", correlationId));
        const parsed = operatorOrganizationQuerySchema.safeParse({
          q: url.searchParams.get("q") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        if (!parsed.success) return reply(failure("VALIDATION", correlationId));
        const result = await deps.service.list(parsed.data);
        return reply(
          result.ok
            ? result
            : { ...result, error: { ...result.error, correlationId } },
        );
      }
      if (request.method === "GET" && path === "organization") {
        if (parameters.some((key) => key !== "organizationId"))
          return reply(failure("VALIDATION", correlationId));
        const parsed = operatorOrganizationDetailQuerySchema.safeParse({
          organizationId: url.searchParams.get("organizationId") ?? undefined,
        });
        if (!parsed.success) return reply(failure("VALIDATION", correlationId));
        const result = await deps.service.detail({
          organizationId: parsed.data.organizationId,
          correlationId,
        });
        return reply(
          result.ok
            ? result
            : { ...result, error: { ...result.error, correlationId } },
        );
      }
      if (!write) return reply(failure("NOT_FOUND", correlationId));
      let body: unknown;
      try {
        body = await readBoundedJson(request, limit);
      } catch {
        return reply(failure("VALIDATION", correlationId));
      }
      if (path === "organizations") {
        const parsed = operatorCreateOrganizationCommandSchema.safeParse(body);
        if (!parsed.success) return reply(failure("VALIDATION", correlationId));
        const result = await deps.service.createOrganization({
          actor,
          command: parsed.data,
          correlationId,
        });
        return reply(
          result.ok
            ? result
            : { ...result, error: { ...result.error, correlationId } },
        );
      }
      if (path === "member-role") {
        const parsed = operatorMemberRoleCommandSchema.safeParse(body);
        if (!parsed.success) return reply(failure("VALIDATION", correlationId));
        const result = await deps.service.setMemberRole({
          actor,
          command: parsed.data,
          correlationId,
        });
        return reply(
          result.ok
            ? { ok: true, value: {} }
            : { ...result, error: { ...result.error, correlationId } },
        );
      }
      return reply(failure("NOT_FOUND", correlationId));
    } catch {
      return reply(failure("DEPENDENCY_UNAVAILABLE", correlationId));
    }
  };
}
