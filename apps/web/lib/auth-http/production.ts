import { parseEnvironment } from "@relay/config";
import { createDatabase, createMembershipReader } from "@relay/db";
import {
  createAuthFromEnvironment,
  createSessionResolver,
  createTenantAuthorization,
} from "../auth/index.ts";
import { createAuthHttpHandlers } from "./index.ts";

let handlers: ReturnType<typeof createAuthHttpHandlers> | undefined;
function production() {
  if (handlers) return handlers;
  const env = parseEnvironment(process.env);
  const { db } = createDatabase(env.DATABASE_URL);
  const auth = createAuthFromEnvironment(db);
  handlers = createAuthHttpHandlers({
    appUrl: env.APP_URL,
    auth,
    sessions: createSessionResolver({
      auth,
      authorization: createTenantAuthorization({ db }),
      memberships: createMembershipReader(db),
      appUrl: env.APP_URL,
      mailConfigured: false,
    }),
  });
  return handlers;
}
export function productionHandler(
  name: keyof ReturnType<typeof createAuthHttpHandlers>,
) {
  return async (request: Request) => {
    try {
      return await production()[name](request);
    } catch {
      return Response.json(
        {
          ok: false,
          error: {
            code: "DEPENDENCY_UNAVAILABLE",
            message: "Authentication service is unavailable",
            correlationId: crypto.randomUUID(),
            retryable: true,
          },
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
  };
}
