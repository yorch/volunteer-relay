import { randomUUID } from "node:crypto";
import { createBlobStore } from "@relay/blob";
import { parseEnvironment } from "@relay/config";
import type { AuthOrganizationOption } from "@relay/contracts";
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
import { isContractRole } from "@relay/domain/auth";
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
import { createProductExtensions } from "./extensions.ts";
import { createFollowThroughHttp } from "./follow-through.ts";
import { createProductHandler, productFailure } from "./http.ts";
import { createOperationsHttp } from "./operations.ts";
import { createRetentionHttp } from "./retention.ts";
import { productSessionUser } from "./session-gate.ts";
import { createWorkspaceActivityReader } from "./workspace-projections.ts";

let handler: ReturnType<typeof createProductHandler> | undefined;
export async function productHandler(request: Request) {
  try {
    if (!handler) {
      const env = parseEnvironment(process.env);
      const { db } = createDatabase(env.DATABASE_URL);
      const blobs = createBlobStore(env);
      const authorization = createTenantAuthorization({ db });
      const auth = createProductionAuth(db);
      const memberships = createMembershipReader(db);
      const followThrough = createFollowThroughRepository(db);
      const timezoneFor = async (organizationId: string) =>
        (await followThrough.getSettingsInternal(organizationId)).timezone;
      const sessions = createSessionResolver({
        auth,
        authorization,
        memberships,
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
        blobs: { read: (key) => blobs.read(key) },
      });
      const extended = createProductExtensions({
        db,
        authorization,
        sources,
        processing,
        attachments,
        store: blobs,
        maxBytes: env.ATTACHMENT_MAX_BYTES,
        timezone: timezoneFor,
        transactional: (tx) => {
          const scopedSettings = createFollowThroughRepository(tx);
          return {
            authorization: createTenantAuthorization({ db: tx }),
            processing: createProcessingRepository(tx),
            timezone: async (organizationId) =>
              (await scopedSettings.getSettingsInternal(organizationId))
                .timezone,
          };
        },
      });
      const followHttp = createFollowThroughHttp(db, auth, sessions);
      const operations = createOperationsHttp(db, blobs);
      const retention = createRetentionHttp(db, env.RETENTION_LEDGER_KEY);
      handler = createProductHandler({
        extensions: async (context, path, request) =>
          (await followHttp(context, path, request)) ??
          (await operations(context, path, request)) ??
          (await retention(context, path, request)) ??
          extended(context, path, request),
        appUrl: env.APP_URL,
        activityFacts: createWorkspaceActivityReader(db),
        timezone: (context) => timezoneFor(context.organizationId),
        authorization,
        sources,
        processing,
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
          // A session without a verified email never reaches tenant data.
          const gate = productSessionUser(session.response);
          if (!gate.ok) return productFailure(gate.code, correlationId);
          // The session was verified above; list memberships directly instead
          // of re-reading the session (a second read duplicates set-cookie).
          let rows: Awaited<
            ReturnType<typeof memberships.listMembershipsForUser>
          >;
          try {
            rows = await memberships.listMembershipsForUser(gate.userId);
          } catch {
            return productFailure("DEPENDENCY_UNAVAILABLE", correlationId);
          }
          const organizations = rows
            .filter((row) => isContractRole(row.role))
            .map((row) => ({
              organizationId: row.organizationId,
              membershipId: row.membershipId,
              name: row.organizationName,
              slug: row.organizationSlug,
              role: row.role as AuthOrganizationOption["role"],
            }));
          const selected = session.response?.session.activeOrganizationId;
          const organization =
            organizations.find((o) => o.organizationId === selected) ??
            (organizations.length === 1 ? organizations[0] : undefined);
          if (!organization) return productFailure("FORBIDDEN", correlationId);
          const context = await authorization.resolve(
            gate.userId,
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
