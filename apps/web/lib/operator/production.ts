import { randomUUID } from "node:crypto";
import { parseEnvironment } from "@relay/config";
import type { Result } from "@relay/contracts";
import { createDatabase } from "@relay/db";
import { createRateLimiter } from "../auth-http/rate-limit.ts";
import { createProductionAuth } from "../mail/production.ts";
import { productSessionUser } from "../product/session-gate.ts";
import { createOperatorDirectory } from "./accounts.ts";
import { createOperatorHandler, type OperatorSessionActor } from "./http.ts";
import { createOperatorService } from "./service.ts";
import { createOperatorStore } from "./store.ts";

type Handler = ReturnType<typeof createOperatorHandler>;

const notConfigured: Handler = async () =>
  Response.json(
    {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: "Resource was not found",
        correlationId: randomUUID(),
        retryable: false,
      },
    } satisfies Result<never>,
    { status: 404, headers: { "cache-control": "no-store" } },
  );

let handler: Handler | undefined;

/**
 * Operator console composition. Parsed once per process; when the allowlist is
 * empty the returned handler answers 404 before any database connection is
 * opened, so an ordinary deployment carries no cross-organization surface.
 */
export async function operatorHandler(request: Request) {
  try {
    if (!handler) {
      const env = parseEnvironment(process.env);
      const directory = createOperatorDirectory(env.OPERATOR_ACCOUNTS);
      if (!directory.enabled) {
        handler = notConfigured;
      } else {
        const { db } = createDatabase(env.DATABASE_URL);
        const auth = createProductionAuth(db);
        handler = createOperatorHandler({
          appUrl: env.APP_URL,
          rateLimiter: createRateLimiter(),
          service: createOperatorService(createOperatorStore(db)),
          async resolve(req, responseHeaders) {
            const correlationId = randomUUID();
            const session = await auth.api.getSession({
              headers: req.headers,
              returnHeaders: true,
            });
            for (const cookie of session.headers.getSetCookie())
              responseHeaders.append("set-cookie", cookie);
            // Same verified-session gate as tenant product traffic: an
            // unverified address is refused before any allowlist comparison.
            const gate = productSessionUser(session.response);
            if (!gate.ok)
              return {
                ok: false,
                error: {
                  code: gate.code,
                  message: "",
                  correlationId,
                  retryable: false,
                },
              };
            const user = session.response?.user;
            const createdAt = session.response?.session?.createdAt;
            const email = typeof user?.email === "string" ? user.email : "";
            const operator = directory.identify({
              userId: gate.userId,
              email,
              emailVerified: user?.emailVerified === true,
            });
            if (!operator)
              return {
                ok: false,
                error: {
                  code: "FORBIDDEN",
                  message: "",
                  correlationId,
                  retryable: false,
                },
              };
            const created =
              createdAt instanceof Date ? createdAt : new Date(createdAt ?? 0);
            return {
              ok: true,
              value: {
                userId: operator.userId,
                sessionCreatedAt: created,
              } satisfies OperatorSessionActor,
            };
          },
        });
      }
    }
    return await handler(request);
  } catch {
    return Response.json(
      {
        ok: false,
        error: {
          code: "DEPENDENCY_UNAVAILABLE",
          message: "The service is temporarily unavailable",
          correlationId: randomUUID(),
          retryable: true,
        },
      } satisfies Result<never>,
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
