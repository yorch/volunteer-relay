import {
  type Result,
  roleSchema,
  type TenantContext,
  updateOrganizationSettingsSchema,
} from "@relay/contracts";
import { createFollowThroughRepository, type Database, sql } from "@relay/db";
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
    if (path === "settings" && request.method === "GET")
      return repo.getSettings(context);
    if (path === "notifications" && request.method === "GET")
      return repo.listNotifications(context);
    if (path === "members" && request.method === "GET") {
      if (context.actor.role !== "owner") return fail("FORBIDDEN");
      const rows = await db.execute(
        sql`select m.id as "membershipId",u.name,u.email,m.role from member m join "user" u on u.id=m.user_id where m.organization_id=${context.organizationId} order by u.name,m.id`,
      );
      return { ok: true, value: rows.rows };
    }
    if (path === "candidates" && request.method === "GET") {
      if (!["owner", "coordinator"].includes(context.actor.role))
        return fail("FORBIDDEN");
      const sourceId = new URL(request.url).searchParams.get("sourceId");
      if (!sourceId) return fail("VALIDATION");
      const rows = await db.execute(
        sql`select a.id as "activityId",a.revision,'Similar date or beneficiary; staff must verify source evidence' as reason from activity a where a.organization_id=${context.organizationId} and exists (select 1 from source_revision s where s.organization_id=a.organization_id and s.source_id=${sourceId} and ((s.occurred_at at time zone s.timezone)::date=a.local_date or (a.beneficiary_reference is not null and position(lower(a.beneficiary_reference) in lower(s.text_body))>0))) order by a.created_at desc,a.id limit 20`,
      );
      return { ok: true, value: rows.rows };
    }
    if (
      ![
        "settings",
        "notification-read",
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
    if (context.actor.role !== "owner") return fail("FORBIDDEN");
    if (path === "members/invite") {
      const role = roleSchema.safeParse(input.role);
      if (typeof input.email !== "string" || !role.success)
        return fail("VALIDATION");
      return sessions.createInvitation({
        headers: request.headers,
        organizationId: context.organizationId,
        email: input.email,
        role: role.data,
        correlationId: context.correlationId,
      });
    }
    if (typeof input.membershipId !== "string") return fail("VALIDATION");
    try {
      if (path === "members/role") {
        const role = roleSchema.safeParse(input.role);
        if (!role.success) return fail("VALIDATION");
        await auth.api.updateMemberRole({
          headers: request.headers,
          body: {
            organizationId: context.organizationId,
            memberId: input.membershipId,
            role: role.data,
          },
        });
      } else
        await auth.api.removeMember({
          headers: request.headers,
          body: {
            organizationId: context.organizationId,
            memberIdOrEmail: input.membershipId,
          },
        });
      return { ok: true, value: undefined };
    } catch {
      return fail("FORBIDDEN");
    }
  };
}
