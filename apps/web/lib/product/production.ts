import { randomUUID } from "node:crypto";
import { parseEnvironment } from "@relay/config";
import {
  and,
  createDatabase,
  createDomainStore,
  createMembershipReader,
  createProcessingRepository,
  createSourceStore,
  eq,
  schema,
} from "@relay/db";
import {
  createLedgerService,
  createNeedService,
  createSourceRepository,
} from "@relay/domain/core";
import {
  createAuthFromEnvironment,
  createSessionResolver,
  createTenantAuthorization,
} from "../auth/index.ts";
import { createProductHandler, productFailure } from "./http.ts";

let handler: ReturnType<typeof createProductHandler> | undefined;
export async function productHandler(request: Request) {
  try {
    if (!handler) {
      const env = parseEnvironment(process.env);
      const { db } = createDatabase(env.DATABASE_URL);
      const authorization = createTenantAuthorization({ db });
      const auth = createAuthFromEnvironment(db);
      const sessions = createSessionResolver({
        auth,
        authorization,
        memberships: createMembershipReader(db),
        appUrl: env.APP_URL,
        mailConfigured: false,
      });
      const store = createDomainStore(db);
      handler = createProductHandler({
        appUrl: env.APP_URL,
        authorization,
        sources: createSourceRepository({
          authorization,
          store: createSourceStore(db),
        }),
        processing: createProcessingRepository(db),
        ledger: createLedgerService({ authorization, store }),
        needs: createNeedService({ authorization, store }),
        async resolve(req, responseHeaders) {
          const correlationId = randomUUID();
          const session = await auth.api.getSession({
            headers: req.headers,
            returnHeaders: true,
          });
          for (const cookie of session.headers.getSetCookie())
            responseHeaders.append("set-cookie", cookie);
          if (!session.response?.user)
            return productFailure("UNAUTHENTICATED", correlationId);
          const organizations = await sessions.listAvailableOrganizations({
            headers: req.headers,
            responseHeaders,
            correlationId,
          });
          if (!organizations.ok) return organizations;
          const selected = session.response.session.activeOrganizationId;
          const organization =
            organizations.value.find((o) => o.organizationId === selected) ??
            (organizations.value.length === 1
              ? organizations.value[0]
              : undefined);
          if (!organization) return productFailure("FORBIDDEN", correlationId);
          const context = await authorization.resolve(
            session.response.user.id,
            organization.organizationId,
            correlationId,
          );
          return context.ok
            ? {
                ok: true as const,
                value: { context: context.value, organization },
              }
            : context;
        },
        async members(context) {
          return db
            .select({ membershipId: schema.member.id, name: schema.user.name })
            .from(schema.member)
            .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
            .where(
              and(eq(schema.member.organizationId, context.organizationId)),
            );
        },
      });
    }
    return await handler(request);
  } catch {
    return Response.json(
      productFailure("DEPENDENCY_UNAVAILABLE", randomUUID()),
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
