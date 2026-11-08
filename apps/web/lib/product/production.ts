import { randomUUID } from "node:crypto";
import { parseEnvironment } from "@relay/config";
import {
  and,
  createAttachmentMetadataStore,
  createDatabase,
  createDomainStore,
  createFollowThroughRepository,
  createMembershipReader,
  createProcessingRepository,
  createSourceStore,
  eq,
  schema,
} from "@relay/db";
import {
  createAttachmentReader,
  createLedgerService,
  createNeedService,
  createSourceRepository,
} from "@relay/domain/core";
import {
  createSessionResolver,
  createTenantAuthorization,
} from "../auth/index.ts";
import { createProductionAuth } from "../mail/production.ts";
import { createProductExtensions, readPrivateBlob } from "./extensions.ts";
import { createFollowThroughHttp } from "./follow-through.ts";
import { createProductHandler, productFailure } from "./http.ts";
import { createOperationsHttp } from "./operations.ts";
import { createRetentionHttp } from "./retention.ts";

let handler: ReturnType<typeof createProductHandler> | undefined;
export async function productHandler(request: Request) {
  try {
    if (!handler) {
      const env = parseEnvironment(process.env);
      const { db } = createDatabase(env.DATABASE_URL);
      const authorization = createTenantAuthorization({ db });
      const auth = createProductionAuth(db);
      const sessions = createSessionResolver({
        auth,
        authorization,
        memberships: createMembershipReader(db),
        appUrl: env.APP_URL,
        mailConfigured: true,
      });
      const store = createDomainStore(db);
      const sources = createSourceRepository({
        authorization,
        store: createSourceStore(db),
      });
      const processing = createProcessingRepository(db);
      const attachments = createAttachmentReader({
        authorization,
        metadata: createAttachmentMetadataStore(db),
        blobs: { read: (key) => readPrivateBlob(env.ATTACHMENT_ROOT, key) },
      });
      const extended = createProductExtensions({
        db,
        authorization,
        sources,
        processing,
        attachments,
        root: env.ATTACHMENT_ROOT,
        maxBytes: env.ATTACHMENT_MAX_BYTES,
        timezone: async (org) =>
          (await createFollowThroughRepository(db).getSettingsInternal(org))
            .timezone,
      });
      const followHttp = createFollowThroughHttp(db, auth, sessions);
      const operations = createOperationsHttp(db, env.ATTACHMENT_ROOT);
      const retention = createRetentionHttp(
        db,
        process.env.RETENTION_LEDGER_KEY,
      );
      handler = createProductHandler({
        extensions: async (context, path, request) =>
          (await followHttp(context, path, request)) ??
          (await operations(context, path, request)) ??
          (await retention(context, path, request)) ??
          extended(context, path, request),
        appUrl: env.APP_URL,
        timezone: async (context) =>
          (
            await createFollowThroughRepository(db).getSettingsInternal(
              context.organizationId,
            )
          ).timezone,
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
