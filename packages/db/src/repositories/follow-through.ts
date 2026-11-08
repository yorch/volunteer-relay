import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type OrganizationSettings,
  type ProductNotification,
  type Result,
  type SourceEnvelope,
  type TenantContext,
  type UpdateOrganizationSettings,
  updateOrganizationSettingsSchema,
} from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

type Executor = Pick<Database, "execute">;
export type FollowThroughSettings = OrganizationSettings;
export type SettingsUpdate = UpdateOrganizationSettings;
export type FollowThroughNotification = ProductNotification;
export interface DeliveryClaim {
  id: string;
  organizationId: string;
  recipientId: string;
  channel: "email" | "telegram";
  deliveryKey: string;
  template: string;
  appPath: string;
  leaseToken: string;
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function err(
  context: Pick<TenantContext, "correlationId">,
  code:
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "VALIDATION"
    | "CONFLICT"
    | "DEPENDENCY_UNAVAILABLE",
  message: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      correlationId: context.correlationId || "-",
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}
class Stop extends Error {
  code: "VALIDATION" | "CONFLICT" | "NOT_FOUND";
  constructor(code: "VALIDATION" | "CONFLICT" | "NOT_FOUND", message: string) {
    super(message);
    this.code = code;
  }
}
const stable = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, stable(x)]),
        )
      : v;
const digest = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(stable(v)))
    .digest("hex");
const textJson = (v: unknown) => JSON.stringify(v);
const defaultSettings: FollowThroughSettings = {
  revision: 1,
  timezone: "UTC",
  automationPolicy: "review-all",
  policyVersion: "1",
  routing: {},
  fallbackMembershipId: null,
  ackMinutes: 60,
  retentionDays: 365,
};
function mapSettings(
  row: Record<string, unknown> | undefined,
): FollowThroughSettings {
  return row
    ? {
        revision: row.revision as number,
        timezone: row.timezone as string,
        automationPolicy:
          row.automation_policy as FollowThroughSettings["automationPolicy"],
        policyVersion: row.policy_version as string,
        routing: row.routing as Record<string, string[]>,
        fallbackMembershipId: row.fallback_membership_id as string | null,
        ackMinutes: row.ack_minutes as number,
        retentionDays: row.retention_days as number,
      }
    : structuredClone(defaultSettings);
}
async function authorize(
  db: Executor,
  c: TenantContext,
): Promise<string | null> {
  if (c.actor.kind !== "user") return null;
  const r = await db.execute(
    sql`select role from member where organization_id=${c.organizationId} and id=${c.actor.membershipId} and user_id=${c.actor.userId} for share`,
  );
  return (r.rows[0]?.role as string | undefined) ?? null;
}
function validSettings(s: SettingsUpdate): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: s.timezone });
  } catch {
    return false;
  }
  return (
    Number.isInteger(s.expectedRevision) &&
    s.expectedRevision > 0 &&
    typeof s.idempotencyKey === "string" &&
    s.idempotencyKey.length > 0 &&
    ["review-all", "validated-auto-record"].includes(s.automationPolicy) &&
    typeof s.policyVersion === "string" &&
    s.policyVersion.length > 0 &&
    Number.isInteger(s.ackMinutes) &&
    s.ackMinutes >= 1 &&
    s.ackMinutes <= 10080 &&
    Number.isInteger(s.retentionDays) &&
    s.retentionDays >= 1 &&
    s.retentionDays <= 3650 &&
    (s.fallbackMembershipId === null ||
      (typeof s.fallbackMembershipId === "string" &&
        s.fallbackMembershipId.length > 0)) &&
    s.routing !== null &&
    typeof s.routing === "object" &&
    !Array.isArray(s.routing) &&
    Object.entries(s.routing).every(
      ([k, v]) =>
        k.length > 0 &&
        Array.isArray(v) &&
        v.every((x) => typeof x === "string" && x.length > 0) &&
        new Set(v).size === v.length,
    )
  );
}
async function replay(
  tx: Executor,
  org: string,
  key: string,
  operation: string,
  input: unknown,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([org, key])},0))`,
  );
  const r = await tx.execute(
    sql`select operation,digest,result from follow_through_command where organization_id=${org} and idempotency_key=${key}`,
  );
  if (!r.rows[0]) return null;
  if (r.rows[0].operation !== operation || r.rows[0].digest !== digest(input))
    throw new Stop("CONFLICT", "Idempotency key already used");
  return r.rows[0].result;
}
async function saveCommand(
  tx: Executor,
  org: string,
  key: string,
  operation: string,
  input: unknown,
  result: unknown,
) {
  await tx.execute(
    sql`insert into follow_through_command(organization_id,idempotency_key,operation,digest,result) values (${org},${key},${operation},${digest(input)},${textJson(result)}::jsonb)`,
  );
}
const staff = (role: string | null) =>
  role === "owner" || role === "coordinator";
const fixed = (c: TenantContext, e: unknown): Result<never> =>
  e instanceof Stop
    ? err(c, e.code, e.message)
    : err(c, "DEPENDENCY_UNAVAILABLE", "Follow-through storage unavailable");

export function createFollowThroughRepository(
  db: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
) {
  return {
    async getSettings(
      context: TenantContext,
    ): Promise<Result<FollowThroughSettings>> {
      try {
        if (!staff(await authorize(db, context)))
          return err(context, "FORBIDDEN", "Settings authority required");
        const r = await db.execute(
          sql`select * from organization_settings where organization_id=${context.organizationId}`,
        );
        return ok(mapSettings(r.rows[0]));
      } catch (e) {
        return fixed(context, e);
      }
    },
    async getSettingsInternal(
      organizationId: string,
    ): Promise<FollowThroughSettings> {
      const r = await db.execute(
        sql`select * from organization_settings where organization_id=${organizationId}`,
      );
      return mapSettings(r.rows[0]);
    },
    async updateSettings(
      context: TenantContext,
      input: SettingsUpdate,
    ): Promise<Result<FollowThroughSettings>> {
      if (
        !updateOrganizationSettingsSchema.safeParse(input).success ||
        !validSettings(input)
      )
        return err(context, "VALIDATION", "Invalid settings");
      try {
        return await db.transaction(async (tx) => {
          if ((await authorize(tx, context)) !== "owner")
            return err(context, "FORBIDDEN", "Owner authority required");
          const prior = await replay(
            tx,
            context.organizationId,
            input.idempotencyKey,
            "settings",
            input,
          );
          if (prior) return ok(prior as FollowThroughSettings);
          await tx.execute(
            sql`select id from organization where id=${context.organizationId} for update`,
          );
          const r = await tx.execute(
            sql`select * from organization_settings where organization_id=${context.organizationId} for update`,
          );
          const current = mapSettings(r.rows[0]);
          if (current.revision !== input.expectedRevision)
            throw new Stop("CONFLICT", "Settings revision changed");
          for (const id of new Set([
            ...Object.values(input.routing).flat(),
            ...(input.fallbackMembershipId ? [input.fallbackMembershipId] : []),
          ])) {
            const m = await tx.execute(
              sql`select id from member where organization_id=${context.organizationId} and id=${id} and role in ('owner','coordinator') for share`,
            );
            if (!m.rows.length)
              throw new Stop("VALIDATION", "Routing membership unavailable");
          }
          const updated: FollowThroughSettings = {
            revision: current.revision + 1,
            timezone: input.timezone,
            automationPolicy: input.automationPolicy,
            policyVersion: input.policyVersion,
            routing: input.routing,
            fallbackMembershipId: input.fallbackMembershipId,
            ackMinutes: input.ackMinutes,
            retentionDays: input.retentionDays,
          };
          await tx.execute(
            sql`insert into organization_settings(organization_id,revision,timezone,automation_policy,policy_version,routing,fallback_membership_id,ack_minutes,retention_days) values (${context.organizationId},${updated.revision},${updated.timezone},${updated.automationPolicy},${updated.policyVersion},${textJson(updated.routing)}::jsonb,${updated.fallbackMembershipId},${updated.ackMinutes},${updated.retentionDays}) on conflict (organization_id) do update set revision=excluded.revision,timezone=excluded.timezone,automation_policy=excluded.automation_policy,policy_version=excluded.policy_version,routing=excluded.routing,fallback_membership_id=excluded.fallback_membership_id,ack_minutes=excluded.ack_minutes,retention_days=excluded.retention_days`,
          );
          await saveCommand(
            tx,
            context.organizationId,
            input.idempotencyKey,
            "settings",
            input,
            updated,
          );
          return ok(updated);
        });
      } catch (e) {
        return fixed(context, e);
      }
    },
    async listNotifications(
      context: TenantContext,
    ): Promise<Result<ProductNotification[]>> {
      try {
        const role = await authorize(db, context);
        if (!role || context.actor.kind !== "user")
          return err(context, "FORBIDDEN", "Membership required");
        const rows = await db.execute(
          sql`select id,revision,type,need_id,title,app_path,created_at,read_at from in_app_notification where organization_id=${context.organizationId} and recipient_id=${context.actor.membershipId} order by created_at desc,id limit 200`,
        );
        return ok(
          rows.rows.map((r) => ({
            id: r.id as string,
            revision: r.revision as number,
            type: r.type as ProductNotification["type"],
            needId: r.need_id as string,
            title: r.title as string,
            appPath: r.app_path as string,
            createdAt: new Date(r.created_at as string).toISOString(),
            readAt: r.read_at
              ? new Date(r.read_at as string).toISOString()
              : null,
          })),
        );
      } catch (e) {
        return fixed(context, e);
      }
    },
    async markNotificationRead(
      context: TenantContext,
      input: {
        notificationId: string;
        expectedRevision: number;
        idempotencyKey: string;
      },
    ): Promise<Result<ProductNotification>> {
      if (
        !input.notificationId ||
        !input.idempotencyKey ||
        !Number.isInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      )
        return err(context, "VALIDATION", "Invalid notification command");
      try {
        return await db.transaction(async (tx) => {
          if (!(await authorize(tx, context)) || context.actor.kind !== "user")
            return err(context, "FORBIDDEN", "Membership required");
          const prior = await replay(
            tx,
            context.organizationId,
            input.idempotencyKey,
            "notification.read",
            { ...input, actor: context.actor.membershipId },
          );
          if (prior) return ok(prior as ProductNotification);
          const rows = await tx.execute(
            sql`select * from in_app_notification where organization_id=${context.organizationId} and id=${input.notificationId} and recipient_id=${context.actor.membershipId} for update`,
          );
          const r = rows.rows[0];
          if (!r) throw new Stop("NOT_FOUND", "Notification not found");
          if (r.revision !== input.expectedRevision)
            throw new Stop("CONFLICT", "Notification revision changed");
          const time = now();
          const revision = input.expectedRevision + 1;
          await tx.execute(
            sql`update in_app_notification set revision=${revision},read_at=coalesce(read_at,${time}) where organization_id=${context.organizationId} and id=${input.notificationId}`,
          );
          const result: ProductNotification = {
            id: r.id as string,
            revision,
            type: r.type as ProductNotification["type"],
            needId: r.need_id as string,
            title: r.title as string,
            appPath: r.app_path as string,
            createdAt: new Date(r.created_at as string).toISOString(),
            readAt: (r.read_at
              ? new Date(r.read_at as string)
              : time
            ).toISOString(),
          };
          await saveCommand(
            tx,
            context.organizationId,
            input.idempotencyKey,
            "notification.read",
            { ...input, actor: context.actor.membershipId },
            result,
          );
          return ok(result);
        });
      } catch (e) {
        return fixed(context, e);
      }
    },
    async setNotificationPreferences(
      context: TenantContext,
      preferences: { email: boolean; telegram: boolean },
    ): Promise<Result<void>> {
      if (
        typeof preferences.email !== "boolean" ||
        typeof preferences.telegram !== "boolean"
      )
        return err(context, "VALIDATION", "Invalid preferences");
      try {
        return await db.transaction(async (tx) => {
          if (!(await authorize(tx, context)) || context.actor.kind !== "user")
            return err(context, "FORBIDDEN", "Membership required");
          await tx.execute(
            sql`insert into notification_preference(organization_id,membership_id,email,telegram) values (${context.organizationId},${context.actor.membershipId},${preferences.email},${preferences.telegram}) on conflict(organization_id,membership_id) do update set email=excluded.email,telegram=excluded.telegram`,
          );
          return ok(undefined);
        });
      } catch (e) {
        return fixed(context, e);
      }
    },
    async processPendingNotifications(limit: number): Promise<number> {
      bounded(limit);
      return db
        .transaction(async (tx) => {
          const events = await tx.execute(
            sql`select e.organization_id,e.id,e.aggregate_id,e.aggregate_revision from outbox_event e where e.type='need.changed' and not exists(select 1 from notification_event n where n.organization_id=e.organization_id and n.event_id=e.id) order by e.occurred_at,e.id for update of e skip locked limit ${limit}`,
          );
          for (const e of events.rows) {
            const org = e.organization_id as string;
            const needId = e.aggregate_id as string;
            const n = await tx.execute(
              sql`select status,revision,owner_membership_id,urgency,category from need where organization_id=${org} and id=${needId} for update`,
            );
            const row = n.rows[0];
            if (
              row &&
              row.revision === e.aggregate_revision &&
              row.status === "assigned" &&
              row.owner_membership_id
            ) {
              await createNotification(
                tx,
                org,
                row.owner_membership_id as string,
                needId,
                "need-assigned",
                `need:${needId}:revision:${row.revision}`,
                now(),
                null,
                row.revision as number,
              );
            } else if (
              row &&
              row.revision === e.aggregate_revision &&
              row.status === "new" &&
              row.urgency === "urgent"
            ) {
              const recipients = await routedRecipients(
                tx,
                org,
                row.category as string,
              );
              for (const recipient of recipients)
                await createNotification(
                  tx,
                  org,
                  recipient,
                  needId,
                  "need-assigned",
                  `need:${needId}:urgent:${row.revision}`,
                  now(),
                  null,
                  row.revision as number,
                  true,
                );
            }
            await tx.execute(
              sql`insert into notification_event(organization_id,event_id) values (${org},${e.id as string}) on conflict do nothing`,
            );
          }
          return events.rows.length;
        })
        .catch(() => {
          throw new Error("Follow-through storage unavailable");
        });
    },
    async escalateOverdue(limit: number): Promise<number> {
      bounded(limit);
      return db
        .transaction(async (tx) => {
          const time = now();
          const needs = await tx.execute(
            sql`select n.organization_id,n.id,n.acknowledge_by,n.category,n.revision from need n where n.status='assigned' and n.acknowledge_by is not null and n.acknowledge_by<=${time} and not exists(select 1 from need_escalation e where e.organization_id=n.organization_id and e.need_id=n.id and e.deadline=n.acknowledge_by and e.assignment_revision=n.revision and e.level=1) order by n.acknowledge_by,n.id for update of n skip locked limit ${limit}`,
          );
          for (const n of needs.rows) {
            const org = n.organization_id as string;
            const needId = n.id as string;
            const deadline = new Date(n.acknowledge_by as string);
            const selected = await routedRecipients(
              tx,
              org,
              n.category as string,
            );
            for (const recipient of selected)
              await createNotification(
                tx,
                org,
                recipient,
                needId,
                "need-overdue",
                `need:${needId}:revision:${n.revision}:deadline:${deadline.toISOString()}:level:1`,
                time,
                deadline,
                n.revision as number,
              );
            await tx.execute(
              sql`insert into need_escalation(organization_id,need_id,deadline,assignment_revision,level,created_at) values (${org},${needId},${deadline},${n.revision as number},1,${time}) on conflict do nothing`,
            );
          }
          return needs.rows.length;
        })
        .catch(() => {
          throw new Error("Follow-through storage unavailable");
        });
    },
    async claimDeliveries(limit: number): Promise<DeliveryClaim[]> {
      bounded(limit);
      return db
        .transaction(async (tx) => {
          const time = now();
          const rows = await tx.execute(
            sql`with picked as (select j.organization_id,j.id from delivery_job j join member m on m.organization_id=j.organization_id and m.id=j.recipient_id join need n on n.organization_id=j.organization_id and n.id=j.need_id where j.attempts<3 and j.accepted_at is null and (j.lease_until is null or j.lease_until<=${time}) and (j.retry_after is null or j.retry_after<=${time}) and n.revision=j.need_revision and ((j.template='need-assigned' and ((n.status='assigned' and n.owner_membership_id=j.recipient_id) or (n.status='new' and n.urgency='urgent'))) or (j.template='need-overdue' and n.status='assigned' and n.acknowledge_by=j.need_deadline and n.acknowledge_by<=${time})) and m.role in ('owner','coordinator') and exists (select 1 from notification_preference p where p.organization_id=j.organization_id and p.membership_id=j.recipient_id and ((j.channel='email' and p.email) or (j.channel='telegram' and p.telegram))) order by j.created_at,j.id for update of j skip locked limit ${limit}), claimed as (update delivery_job j set attempts=j.attempts+1,lease_token=gen_random_uuid()::text,lease_until=${time}::timestamptz+interval '5 minutes' from picked p where (j.organization_id,j.id)=(p.organization_id,p.id) returning j.*) select * from claimed`,
          );
          return rows.rows.map((r) => ({
            id: r.id as string,
            organizationId: r.organization_id as string,
            recipientId: r.recipient_id as string,
            channel: r.channel as DeliveryClaim["channel"],
            deliveryKey: r.delivery_key as string,
            template: r.template as string,
            appPath: r.app_path as string,
            leaseToken: r.lease_token as string,
          }));
        })
        .catch(() => {
          throw new Error("Follow-through storage unavailable");
        });
    },
    // Call immediately before the external send; provider delivery remains at-least-once.
    async validateDelivery(job: DeliveryClaim): Promise<boolean> {
      try {
        const time = now();
        const rows = await db.execute(
          sql`select 1 from delivery_job j join member m on m.organization_id=j.organization_id and m.id=j.recipient_id join need n on n.organization_id=j.organization_id and n.id=j.need_id join notification_preference p on p.organization_id=j.organization_id and p.membership_id=j.recipient_id where j.organization_id=${job.organizationId} and j.id=${job.id} and j.recipient_id=${job.recipientId} and j.channel=${job.channel} and j.delivery_key=${job.deliveryKey} and j.template=${job.template} and j.app_path=${job.appPath} and j.lease_token=${job.leaseToken} and j.lease_until>${time} and j.accepted_at is null and m.role in ('owner','coordinator') and ((j.channel='email' and p.email) or (j.channel='telegram' and p.telegram)) and n.revision=j.need_revision and ((j.template='need-assigned' and ((n.status='assigned' and n.owner_membership_id=j.recipient_id) or (n.status='new' and n.urgency='urgent'))) or (j.template='need-overdue' and n.status='assigned' and n.acknowledge_by=j.need_deadline and n.acknowledge_by<=${time}))`,
        );
        return rows.rows.length > 0;
      } catch {
        throw new Error("Follow-through storage unavailable");
      }
    },
    async completeDelivery(
      job: DeliveryClaim,
      result: { status: "accepted"; providerId: string } | { status: "failed" },
    ): Promise<boolean> {
      return db
        .transaction(async (tx) => {
          const time = now();
          const rows = await tx.execute(
            sql`select attempts from delivery_job where organization_id=${job.organizationId} and id=${job.id} and lease_token=${job.leaseToken} and lease_until>${time} for update`,
          );
          if (!rows.rows[0]) return false;
          const accepted = result.status === "accepted";
          const providerId = accepted ? result.providerId : null;
          if (accepted && !providerId)
            throw new Error("Invalid delivery result");
          await tx.execute(
            sql`insert into delivery_attempt(organization_id,job_id,attempt,accepted,provider_id,occurred_at) values (${job.organizationId},${job.id},${rows.rows[0].attempts as number},${accepted},${providerId},${time})`,
          );
          await tx.execute(
            sql`update delivery_job set lease_token=null,lease_until=null,accepted_at=${accepted ? time : null},provider_id=${providerId},retry_after=${accepted ? null : new Date(time.getTime() + 60000)} where organization_id=${job.organizationId} and id=${job.id}`,
          );
          return true;
        })
        .catch(() => {
          throw new Error("Follow-through storage unavailable");
        });
    },
    async createTelegramLink(
      context: TenantContext,
      input: { idempotencyKey: string; expiresAt: string },
    ): Promise<
      Result<{ linkId: string; token: string | null; expiresAt: string }>
    > {
      const expires = new Date(input.expiresAt);
      const time = now();
      if (
        !input.idempotencyKey ||
        Number.isNaN(expires.getTime()) ||
        expires <= time ||
        expires.getTime() - time.getTime() > 86400000
      )
        return err(context, "VALIDATION", "Invalid link expiry");
      try {
        return await db.transaction(async (tx) => {
          if (!(await authorize(tx, context)) || context.actor.kind !== "user")
            return err(context, "FORBIDDEN", "Membership required");
          const command = { ...input, member: context.actor.membershipId };
          const prior = await replay(
            tx,
            context.organizationId,
            input.idempotencyKey,
            "telegram.link",
            command,
          );
          if (prior)
            return ok({
              ...(prior as { linkId: string; expiresAt: string }),
              token: null,
            });
          const token = randomBytes(32).toString("base64url");
          const linkId = digest(token);
          await tx.execute(
            sql`insert into telegram_link_token(token_hash,organization_id,membership_id,expires_at,created_at) values (${linkId},${context.organizationId},${context.actor.membershipId},${expires},${time})`,
          );
          const saved = { linkId, expiresAt: expires.toISOString() };
          await saveCommand(
            tx,
            context.organizationId,
            input.idempotencyKey,
            "telegram.link",
            command,
            saved,
          );
          return ok({ ...saved, token });
        });
      } catch (e) {
        return fixed(context, e);
      }
    },
    async revokeTelegramLink(
      context: TenantContext,
      linkId: string,
    ): Promise<Result<void>> {
      try {
        return await db.transaction(async (tx) => {
          if (!(await authorize(tx, context)) || context.actor.kind !== "user")
            return err(context, "FORBIDDEN", "Membership required");
          const rows = await tx.execute(
            sql`update telegram_link_token set revoked_at=coalesce(revoked_at,${now()}) where token_hash=${linkId} and organization_id=${context.organizationId} and membership_id=${context.actor.membershipId} returning token_hash`,
          );
          if (!rows.rows.length) throw new Stop("NOT_FOUND", "Link not found");
          return ok(undefined);
        });
      } catch (e) {
        return fixed(context, e);
      }
    },
    async consumeTelegramLink(
      token: string,
      identity: string,
    ): Promise<Result<{ organizationId: string; membershipId: string }>> {
      const c = { correlationId: "telegram-link" };
      if (!token || !identity) return err(c, "VALIDATION", "Invalid link");
      try {
        return await db.transaction(async (tx) => {
          const time = now();
          const tokenHash = digest(token);
          const rows = await tx.execute(
            sql`select t.* from telegram_link_token t join member m on m.organization_id=t.organization_id and m.id=t.membership_id where t.token_hash=${tokenHash} and t.used_at is null and t.revoked_at is null and t.expires_at>${time} for update of t,m`,
          );
          const row = rows.rows[0];
          if (!row) throw new Stop("NOT_FOUND", "Link unavailable");
          const org = row.organization_id as string;
          const member = row.membership_id as string;
          const existing = await tx.execute(
            sql`select membership_id from telegram_identity where identity=${identity} and organization_id=${org} for update`,
          );
          if (existing.rows[0] && existing.rows[0].membership_id !== member) {
            const live = await tx.execute(
              sql`select id from member where organization_id=${org} and id=${existing.rows[0].membership_id as string} for share`,
            );
            if (live.rows.length)
              throw new Stop("CONFLICT", "Identity already linked");
            await tx.execute(
              sql`delete from telegram_identity where identity=${identity} and organization_id=${org}`,
            );
          }
          await tx.execute(
            sql`insert into telegram_identity(identity,organization_id,membership_id,created_at) values (${identity},${org},${member},${time}) on conflict(identity,organization_id) do nothing`,
          );
          await tx.execute(
            sql`insert into telegram_selection(identity,organization_id,updated_at) values (${identity},${org},${time}) on conflict(identity) do update set organization_id=excluded.organization_id,updated_at=excluded.updated_at`,
          );
          await tx.execute(
            sql`update telegram_link_token set used_at=${time} where token_hash=${tokenHash}`,
          );
          return ok({ organizationId: org, membershipId: member });
        });
      } catch (e) {
        return e instanceof Stop
          ? err(c, e.code, e.message)
          : err(
              c,
              "DEPENDENCY_UNAVAILABLE",
              "Follow-through storage unavailable",
            );
      }
    },
    async unlinkTelegram(
      context: TenantContext,
      input: { identity?: string } = {},
    ): Promise<Result<void>> {
      try {
        return await db.transaction(async (tx) => {
          if (!(await authorize(tx, context)) || context.actor.kind !== "user")
            return err(context, "FORBIDDEN", "Membership required");
          const removed = await tx.execute(
            sql`delete from telegram_identity where organization_id=${context.organizationId} and membership_id=${context.actor.membershipId} and (${input.identity ?? null}::text is null or identity=${input.identity ?? null}) returning identity`,
          );
          for (const row of removed.rows)
            await tx.execute(
              sql`delete from telegram_selection where identity=${row.identity as string} and organization_id=${context.organizationId}`,
            );
          await tx.execute(
            sql`update telegram_link_token set revoked_at=coalesce(revoked_at,${now()}) where organization_id=${context.organizationId} and membership_id=${context.actor.membershipId} and used_at is null`,
          );
          return ok(undefined);
        });
      } catch (e) {
        return fixed(context, e);
      }
    },
    async selectTelegramOrganization(
      identity: string,
      organizationId: string,
    ): Promise<Result<void>> {
      const c = { correlationId: "telegram-select" };
      try {
        return await db.transaction(async (tx) => {
          const rows = await tx.execute(
            sql`select 1 from telegram_identity t join member m on m.organization_id=t.organization_id and m.id=t.membership_id where t.identity=${identity} and t.organization_id=${organizationId} for share of m`,
          );
          if (!rows.rows.length)
            throw new Stop("NOT_FOUND", "Organization unavailable");
          await tx.execute(
            sql`insert into telegram_selection(identity,organization_id,updated_at) values (${identity},${organizationId},${now()}) on conflict(identity) do update set organization_id=excluded.organization_id,updated_at=excluded.updated_at`,
          );
          return ok(undefined);
        });
      } catch (e) {
        return e instanceof Stop
          ? err(c, e.code, e.message)
          : err(
              c,
              "DEPENDENCY_UNAVAILABLE",
              "Follow-through storage unavailable",
            );
      }
    },
    async resolveTelegramIdentity(identity: string): Promise<
      Result<{
        context: TenantContext;
        organizations: Array<{
          organizationId: string;
          membershipId: string;
          name: string;
        }>;
      }>
    > {
      const c = { correlationId: "telegram-resolve" };
      try {
        const rows = await db.execute(
          sql`select t.organization_id,t.membership_id,m.user_id,m.role,o.name,(s.organization_id=t.organization_id) selected from telegram_identity t join member m on m.organization_id=t.organization_id and m.id=t.membership_id join organization o on o.id=t.organization_id left join telegram_selection s on s.identity=t.identity where t.identity=${identity} order by o.name,o.id`,
        );
        const chosen = rows.rows.find((r) => r.selected);
        if (!chosen)
          return err(c, "NOT_FOUND", "Selected membership unavailable");
        const role = chosen.role;
        if (
          role !== "owner" &&
          role !== "coordinator" &&
          role !== "volunteer" &&
          role !== "report-reader"
        )
          return err(c, "FORBIDDEN", "Membership unavailable");
        return ok({
          context: {
            organizationId: chosen.organization_id as string,
            actor: {
              kind: "user",
              userId: chosen.user_id as string,
              membershipId: chosen.membership_id as string,
              role,
            },
            correlationId: `telegram:${randomUUID()}`,
          },
          organizations: rows.rows.map((r) => ({
            organizationId: r.organization_id as string,
            membershipId: r.membership_id as string,
            name: r.name as string,
          })),
        });
      } catch {
        return err(
          c,
          "DEPENDENCY_UNAVAILABLE",
          "Follow-through storage unavailable",
        );
      }
    },
    async getTelegramSourceRevision(
      context: TenantContext,
      channelIdentity: string,
      externalMessageId: string,
    ): Promise<Result<SourceEnvelope | null>> {
      try {
        const role = await authorize(db, context);
        if (!role || context.actor.kind !== "user")
          return err(context, "FORBIDDEN", "Membership required");
        const rows = await db.execute(
          sql`select envelope,author_membership_id from source_revision where organization_id=${context.organizationId} and channel='telegram' and channel_identity=${channelIdentity} and external_message_id=${externalMessageId} and not exists(select 1 from source_redaction z where z.organization_id=source_revision.organization_id and z.source_id=source_revision.source_id) order by revision desc limit 1`,
        );
        const row = rows.rows[0];
        if (!row) return ok(null);
        if (
          !staff(role) &&
          row.author_membership_id !== context.actor.membershipId
        )
          return err(context, "NOT_FOUND", "Source not found");
        return ok(row.envelope as SourceEnvelope);
      } catch (e) {
        return fixed(context, e);
      }
    },
  };
}
function bounded(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid batch limit");
}
async function createNotification(
  tx: Executor,
  organizationId: string,
  recipientId: string,
  needId: string,
  type: ProductNotification["type"],
  dedupeKey: string,
  time: Date,
  deadline: Date | null = null,
  needRevision = 0,
  urgentNew = false,
) {
  const member = await tx.execute(
    sql`select id from member where organization_id=${organizationId} and id=${recipientId} and role in ('owner','coordinator') for share`,
  );
  if (!member.rows.length) return;
  const id = `notification:${digest([organizationId, recipientId, dedupeKey])}`;
  const title =
    type === "need-overdue"
      ? "Need acknowledgment overdue"
      : urgentNew
        ? "Urgent need requires attention"
        : "Need assigned to you";
  const appPath = "/workspace/needs";
  const inserted = await tx.execute(
    sql`insert into in_app_notification(organization_id,id,recipient_id,revision,type,need_id,title,app_path,dedupe_key,created_at) values (${organizationId},${id},${recipientId},1,${type},${needId},${title},${appPath},${dedupeKey},${time}) on conflict do nothing returning id`,
  );
  if (!inserted.rows.length) return;
  const prefs = await tx.execute(
    sql`select email,telegram from notification_preference where organization_id=${organizationId} and membership_id=${recipientId}`,
  );
  for (const channel of ["email", "telegram"] as const) {
    if (!prefs.rows[0]?.[channel]) continue;
    const deliveryKey = digest([
      organizationId,
      recipientId,
      dedupeKey,
      channel,
    ]);
    await tx.execute(
      sql`insert into delivery_job(organization_id,id,recipient_id,channel,delivery_key,template,app_path,need_id,need_deadline,need_revision,created_at) values (${organizationId},${`delivery:${deliveryKey}`},${recipientId},${channel},${deliveryKey},${type},${appPath},${needId},${deadline},${needRevision},${time}) on conflict do nothing`,
    );
  }
}
async function routedRecipients(
  tx: Executor,
  organizationId: string,
  category: string,
): Promise<string[]> {
  const rows = await tx.execute(
    sql`select * from organization_settings where organization_id=${organizationId}`,
  );
  const config = mapSettings(rows.rows[0]);
  const requested = [
    ...new Set([
      ...(config.routing[category] ?? []),
      ...(config.fallbackMembershipId ? [config.fallbackMembershipId] : []),
    ]),
  ];
  const live: string[] = [];
  for (const id of requested) {
    const found = await tx.execute(
      sql`select id from member where organization_id=${organizationId} and id=${id} and role in ('owner','coordinator') for share`,
    );
    if (found.rows.length) live.push(id);
  }
  if (live.length === 0) {
    const staff = await tx.execute(
      sql`select id from member where organization_id=${organizationId} and role in ('owner','coordinator') order by id for share`,
    );
    live.push(...staff.rows.map((r) => r.id as string));
  }
  return live;
}
