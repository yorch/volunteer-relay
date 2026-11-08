import { createHash } from "node:crypto";
import {
  authResetRequestSchema,
  type Result,
  roleSchema,
  type TenantContext,
  updateOrganizationSettingsSchema,
} from "@relay/contracts";
import {
  createAdministrationAuditRepository,
  createFollowThroughRepository,
  createProcessingRepository,
  type Database,
  sql,
} from "@relay/db";
import { APIError } from "better-auth/api";
import type { Auth, SessionResolver } from "../auth/index.ts";
import { productFailure, readProductJson } from "./http.ts";
export function createFollowThroughHttp(
  db: Database,
  auth: Auth,
  sessions: SessionResolver,
) {
  const repo = createFollowThroughRepository(db);
  return async (
    context: TenantContext,
    path: string,
    request: Request,
  ): Promise<Result<unknown> | null> => {
    const fail = (code: Parameters<typeof productFailure>[0]) =>
      productFailure(code, context.correlationId);
    if (context.actor.kind !== "user") return fail("FORBIDDEN");
    const membership = await db.execute(
      sql`select role from member where organization_id=${context.organizationId} and id=${context.actor.membershipId} and user_id=${context.actor.userId}`,
    );
    const currentRole = membership.rows[0]?.role;
    if (!currentRole) return fail("FORBIDDEN");
    if (path === "notification-preferences" && request.method === "GET") {
      const rows = await db.execute(
        sql`select email,telegram from notification_preference where organization_id=${context.organizationId} and membership_id=${context.actor.membershipId}`,
      );
      return {
        ok: true,
        value: rows.rows[0] ?? { email: false, telegram: false },
      };
    }
    if (path === "settings" && request.method === "GET")
      return repo.getSettings(context);
    if (path === "notifications" && request.method === "GET")
      return repo.listNotifications(context);
    if (path === "members" && request.method === "GET") {
      if (currentRole !== "owner") return fail("FORBIDDEN");
      const rows = await db.execute(
        sql`select m.id as "membershipId",u.name,u.email,m.role from member m join "user" u on u.id=m.user_id where m.organization_id=${context.organizationId} and exists(select 1 from member a where a.organization_id=${context.organizationId} and a.id=${context.actor.membershipId} and a.user_id=${context.actor.userId} and a.role='owner') order by u.name,m.id`,
      );
      return { ok: true, value: rows.rows };
    }
    if (path === "candidates" && request.method === "GET") {
      if (!["owner", "coordinator"].includes(String(currentRole)))
        return fail("FORBIDDEN");
      const sourceId = new URL(request.url).searchParams.get("sourceId");
      if (!sourceId) return fail("VALIDATION");
      const rows = await db.execute(
        sql`select a.id as "activityId",a.revision,'Similar date or beneficiary; staff must verify source evidence' as reason from activity a where a.organization_id=${context.organizationId} and exists(select 1 from member caller where caller.organization_id=${context.organizationId} and caller.id=${context.actor.membershipId} and caller.user_id=${context.actor.userId} and caller.role in ('owner','coordinator')) and exists (select 1 from source_revision s where s.organization_id=a.organization_id and s.source_id=${sourceId} and ((s.occurred_at at time zone s.timezone)::date=a.local_date or (a.beneficiary_reference is not null and position(lower(a.beneficiary_reference) in lower(s.text_body))>0))) order by a.created_at desc,a.id limit 20`,
      );
      return { ok: true, value: rows.rows };
    }
    if (
      ![
        "settings",
        "notification-read",
        "retry-source",
        "reprocess-source",
        "notification-preferences",
        "telegram-link",
        "telegram-unlink",
        "members/invite",
        "members/role",
        "members/remove",
      ].includes(path)
    )
      return null;
    if (request.method !== "POST") return fail("NOT_FOUND");
    let input: Record<string, unknown>;
    try {
      input = (await readProductJson(request)) as Record<string, unknown>;
      if (!input || typeof input !== "object" || Array.isArray(input))
        return fail("VALIDATION");
    } catch {
      return fail("VALIDATION");
    }
    if (path === "settings") {
      const parsed = updateOrganizationSettingsSchema.safeParse(input);
      return parsed.success
        ? repo.updateSettings(context, parsed.data)
        : fail("VALIDATION");
    }
    if (path === "reprocess-source") {
      if (
        typeof input.sourceId !== "string" ||
        !Number.isInteger(input.expectedRevision) ||
        typeof input.idempotencyKey !== "string"
      )
        return fail("VALIDATION");
      return createProcessingRepository(db).reprocessSource(context, {
        sourceId: input.sourceId,
        expectedRevision: Number(input.expectedRevision),
        idempotencyKey: input.idempotencyKey,
      });
    }
    if (path === "retry-source") {
      if (
        typeof input.sourceId !== "string" ||
        typeof input.idempotencyKey !== "string"
      )
        return fail("VALIDATION");
      return createProcessingRepository(db).retrySource(context, {
        sourceId: input.sourceId,
        idempotencyKey: input.idempotencyKey,
      });
    }
    if (path === "notification-read") {
      if (
        typeof input.notificationId !== "string" ||
        !Number.isInteger(input.expectedRevision) ||
        typeof input.idempotencyKey !== "string"
      )
        return fail("VALIDATION");
      return repo.markNotificationRead(context, {
        notificationId: input.notificationId,
        expectedRevision: Number(input.expectedRevision),
        idempotencyKey: input.idempotencyKey,
      });
    }
    if (path === "notification-preferences") {
      if (
        typeof input.email !== "boolean" ||
        typeof input.telegram !== "boolean"
      )
        return fail("VALIDATION");
      return repo.setNotificationPreferences(context, {
        email: input.email,
        telegram: input.telegram,
      });
    }
    if (path === "telegram-link") {
      if (
        typeof input.idempotencyKey !== "string" ||
        typeof input.expiresAt !== "string"
      )
        return fail("VALIDATION");
      return repo.createTelegramLink(context, {
        idempotencyKey: input.idempotencyKey,
        expiresAt: input.expiresAt,
      });
    }
    if (path === "telegram-unlink") return repo.unlinkTelegram(context, {});
    if (currentRole !== "owner") return fail("FORBIDDEN");
    const audit = createAdministrationAuditRepository(db);
    const audited = async (
      action: "member.role" | "member.remove" | "member.invite",
      targetId: string,
      execute: () => Promise<Result<unknown>>,
    ): Promise<Result<unknown>> => {
      const started = await audit.beginOperation(context, { action, targetId });
      if (!started.ok) return started;
      try {
        const result = await execute();
        await audit.finishOperation(
          context.organizationId,
          started.value.operationId,
          result.ok ? "succeeded" : "failed",
        );
        return result;
      } catch (error) {
        await audit.finishOperation(
          context.organizationId,
          started.value.operationId,
          "failed",
        );
        return fail(
          error instanceof APIError && error.statusCode < 500
            ? "FORBIDDEN"
            : "DEPENDENCY_UNAVAILABLE",
        );
      }
    };
    if (path === "members/invite") {
      const role = roleSchema.safeParse(input.role),
        email = authResetRequestSchema.safeParse({ email: input.email });
      if (!role.success || !email.success) return fail("VALIDATION");
      return audited(
        "member.invite",
        createHash("sha256")
          .update(email.data.email.toLowerCase())
          .digest("hex"),
        () =>
          sessions.createInvitation({
            headers: request.headers,
            organizationId: context.organizationId,
            email: email.data.email,
            role: role.data,
            correlationId: context.correlationId,
          }),
      );
    }
    if (typeof input.membershipId !== "string") return fail("VALIDATION");
    const membershipId = input.membershipId;
    if (path === "members/role") {
      const role = roleSchema.safeParse(input.role);
      if (!role.success) return fail("VALIDATION");
      return audited("member.role", membershipId, async () => {
        await auth.api.updateMemberRole({
          headers: request.headers,
          body: {
            organizationId: context.organizationId,
            memberId: membershipId,
            role: role.data,
          },
        });
        return { ok: true, value: undefined };
      });
    }
    return audited("member.remove", membershipId, async () => {
      await auth.api.removeMember({
        headers: request.headers,
        body: {
          organizationId: context.organizationId,
          memberIdOrEmail: membershipId,
        },
      });
      return { ok: true, value: undefined };
    });
  };
}
