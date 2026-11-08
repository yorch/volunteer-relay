import { createHash, randomUUID } from "node:crypto";
import {
  type ApiError,
  type AuthOrganizationOption,
  type AuthorizationService,
  contributionTransitionSchema,
  createNeedCommandSchema,
  type LedgerService,
  type NeedService,
  needTransitionSchema,
  type Result,
  recordActivityCommandSchema,
  reviewDecisionSchema,
  type SourceEnvelope,
  type SourceRepository,
  type TenantContext,
  type WorkspaceSnapshot,
  webSourceSubmissionSchema,
} from "@relay/contracts";

export interface ProductProcessing {
  listQueue(
    context: TenantContext,
  ): Promise<Result<WorkspaceSnapshot["queue"]>>;
  listSourceStatuses(
    context: TenantContext,
  ): Promise<Result<WorkspaceSnapshot["sources"]>>;
  getSource(
    context: TenantContext,
    sourceId: string,
  ): Promise<Result<SourceEnvelope>>;
  decide(
    context: TenantContext,
    command: import("@relay/contracts").ReviewDecision,
  ): Promise<Result<import("@relay/contracts").ReviewOutcome>>;
}
export interface ProductHttpDependencies {
  appUrl: string;
  timezone?(context: TenantContext): Promise<string>;
  resolve(
    request: Request,
    responseHeaders: Headers,
  ): Promise<
    Result<{ context: TenantContext; organization: AuthOrganizationOption }>
  >;
  authorization: AuthorizationService;
  sources: SourceRepository;
  processing: ProductProcessing;
  ledger: LedgerService;
  needs: NeedService;
  members(context: TenantContext): Promise<WorkspaceSnapshot["members"]>;
  extensions?(
    context: TenantContext,
    path: string,
    request: Request,
  ): Promise<Result<unknown> | Response | null>;
}
const statuses = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
};
export function productFailure(
  code: ApiError["error"]["code"],
  correlationId: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      correlationId,
      message: {
        UNAUTHENTICATED: "Sign in to continue",
        FORBIDDEN: "This action is not permitted",
        NOT_FOUND: "Resource was not found",
        VALIDATION: "Check the submitted fields",
        CONFLICT: "The record changed. Refresh and try again",
        RATE_LIMITED: "Try again later",
        DEPENDENCY_UNAVAILABLE: "The service is temporarily unavailable",
      }[code],
      retryable: code === "DEPENDENCY_UNAVAILABLE" || code === "RATE_LIMITED",
    },
  };
}
export async function readProductJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new Error("body");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw new Error("body");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function createProductHandler(deps: ProductHttpDependencies) {
  return async (request: Request): Promise<Response> => {
    const correlationId = randomUUID();
    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    const reply = (result: Result<unknown>) =>
      Response.json(
        result.ok ? result : productFailure(result.error.code, correlationId),
        { status: result.ok ? 200 : statuses[result.error.code], headers },
      );
    try {
      if (!["GET", "POST"].includes(request.method))
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, POST", "cache-control": "no-store" },
        });
      if (
        request.method === "POST" &&
        request.headers.get("origin") !== new URL(deps.appUrl).origin
      )
        return reply(productFailure("FORBIDDEN", correlationId));
      const resolved = await deps.resolve(request, headers);
      if (!resolved.ok) return reply(resolved);
      const { context, organization } = resolved.value;
      const path = new URL(request.url).pathname.replace(
        /^\/api\/product\//,
        "",
      );
      if (request.method === "GET" && path === "source") {
        const params = new URL(request.url).searchParams,
          sourceId = params.get("sourceId");
        if (!sourceId || [...params.keys()].some((key) => key !== "sourceId"))
          return reply(productFailure("VALIDATION", correlationId));
        return reply(await deps.processing.getSource(context, sourceId));
      }
      if (request.method === "GET" && path === "workspace") {
        const role = context.actor.kind === "user" ? context.actor.role : null;
        const staff = role === "owner" || role === "coordinator";
        const value: WorkspaceSnapshot = {
          organization,
          members: [],
          sources: [],
          queue: [],
          contributions: [],
          needs: [],
          summary: null,
        };
        if (role !== "report-reader") {
          const contributions = await deps.ledger.listContributions(context, {
            limit: 100,
          });
          const sources = await deps.processing.listSourceStatuses(context);
          if (!contributions.ok) return reply(contributions);
          if (!sources.ok) return reply(sources);
          value.contributions = contributions.value;
          value.sources = sources.value;
        }
        if (staff) {
          const queue = await deps.processing.listQueue(context);
          const needs = await deps.needs.list(context, { limit: 100 });
          if (!queue.ok) return reply(queue);
          if (!needs.ok) return reply(needs);
          value.queue = queue.value;
          value.needs = needs.value;
          value.members = await deps.members(context);
        }
        if (staff || role === "report-reader") {
          const summary = await deps.ledger.summarize(context);
          if (!summary.ok) return reply(summary);
          value.summary = summary.value;
        }
        return reply({ ok: true, value });
      }
      const extended = await deps.extensions?.(context, path, request);
      if (extended)
        return extended instanceof Response ? extended : reply(extended);
      if (request.method !== "POST")
        return reply(productFailure("NOT_FOUND", correlationId));
      let body: unknown;
      try {
        body = await readProductJson(request);
      } catch {
        return reply(productFailure("VALIDATION", correlationId));
      }
      if (path === "sources") {
        const parsed = webSourceSubmissionSchema.safeParse(body);
        if (!parsed.success)
          return reply(productFailure("VALIDATION", correlationId));
        const allowed = await deps.authorization.require(
          context,
          "source:submit",
        );
        if (!allowed.ok) return reply(allowed);
        if (context.actor.kind !== "user")
          return reply(productFailure("FORBIDDEN", correlationId));
        const input = parsed.data;
        const sourceId = createHash("sha256")
          .update(
            JSON.stringify([
              context.organizationId,
              context.actor.membershipId,
              input.idempotencyKey,
            ]),
          )
          .digest("hex");
        const previous = await deps.processing.getSource(context, sourceId);
        if (!previous.ok && previous.error.code !== "NOT_FOUND")
          return reply(previous);
        if (previous.ok) {
          if (previous.value.text !== input.text)
            return reply(productFailure("CONFLICT", correlationId));
          return reply(await deps.sources.accept(context, previous.value));
        }
        const now = new Date().toISOString();
        return reply(
          await deps.sources.accept(context, {
            schemaVersion: 1,
            organizationId: context.organizationId,
            sourceId,
            revision: 1,
            channel: "web",
            channelIdentity: context.actor.membershipId,
            externalMessageId: sourceId,
            idempotencyKey: input.idempotencyKey,
            author: {
              externalIdentity: context.actor.userId,
              membershipId: context.actor.membershipId,
            },
            occurredAt: null,
            receivedAt: now,
            timezone: (await deps.timezone?.(context)) ?? "UTC",
            text: input.text,
            attachments: [],
            replyToSourceId: null,
            replacesRevision: null,
            original: { mediaType: "text/plain", payload: input.text },
          }),
        );
      }
      if (path === "review") {
        const p = reviewDecisionSchema.safeParse(body);
        return reply(
          p.success
            ? await deps.processing.decide(context, p.data)
            : productFailure("VALIDATION", correlationId),
        );
      }
      if (path === "activity") {
        const p = recordActivityCommandSchema.safeParse(body);
        return reply(
          p.success
            ? await deps.ledger.recordActivity(context, p.data)
            : productFailure("VALIDATION", correlationId),
        );
      }
      if (path === "contribution") {
        const p = contributionTransitionSchema.safeParse(body);
        return reply(
          p.success
            ? await deps.ledger.transitionContribution(context, p.data)
            : productFailure("VALIDATION", correlationId),
        );
      }
      if (path === "need") {
        const p = createNeedCommandSchema.safeParse(body);
        return reply(
          p.success
            ? await deps.needs.create(context, p.data)
            : productFailure("VALIDATION", correlationId),
        );
      }
      if (path === "need-transition") {
        const p = needTransitionSchema.safeParse(body);
        return reply(
          p.success
            ? await deps.needs.transition(context, p.data)
            : productFailure("VALIDATION", correlationId),
        );
      }
      return reply(productFailure("NOT_FOUND", correlationId));
    } catch {
      return reply(productFailure("DEPENDENCY_UNAVAILABLE", correlationId));
    }
  };
}
