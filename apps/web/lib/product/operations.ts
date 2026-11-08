import { statfs } from "node:fs/promises";
import type {
  DeliveryStatus,
  OperationalStatus,
  ProductAuditEntry,
  Result,
  TenantContext,
} from "@relay/contracts";
import { type Database, sql } from "@relay/db";
import { productFailure } from "./http.ts";

const timestamp = (value: unknown): string | null =>
  value == null ? null : new Date(value as string | Date).toISOString();

export function createOperationsHttp(db: Database, attachmentRoot: string) {
  return async (
    context: TenantContext,
    path: string,
    request: Request,
  ): Promise<Result<unknown> | null> => {
    if (!["audit", "deliveries", "operations"].includes(path)) return null;
    const fail = (code: Parameters<typeof productFailure>[0]) =>
      productFailure(code, context.correlationId);
    if (request.method !== "GET") return fail("NOT_FOUND");
    if (context.actor.kind !== "user") return fail("FORBIDDEN");
    const actor = context.actor;
    try {
      return await db.transaction(async (tx) => {
        const member = await tx.execute(
          sql`select role from member where organization_id=${context.organizationId} and id=${actor.membershipId} and user_id=${actor.userId} for share`,
        );
        const role = member.rows[0]?.role;
        if (
          role !== actor.role ||
          (path === "operations"
            ? role !== "owner"
            : role !== "owner" && role !== "coordinator")
        )
          return fail("FORBIDDEN");
        if (path === "audit") {
          const params = new URL(request.url).searchParams;
          if (
            [...params.keys()].some(
              (key) => key !== "aggregateId" && key !== "before",
            )
          )
            return fail("VALIDATION");
          const aggregateId = params.get("aggregateId");
          const before = params.get("before");
          if (
            (aggregateId !== null &&
              (!aggregateId || aggregateId.length > 500)) ||
            (before !== null &&
              (!before || !Number.isFinite(Date.parse(before))))
          )
            return fail("VALIDATION");
          const rows =
            await tx.execute(sql`select aggregate_type,aggregate_id,aggregate_revision,action,occurred_at,actor,reason,before,after from (
            select aggregate_type,aggregate_id,aggregate_revision,action,occurred_at,actor,reason,before,after,id as sort_id from domain_audit_event where organization_id=${context.organizationId}
            union all select 'source',r.source_id,r.source_revision,'review:' || coalesce(d.command->>'decision','redacted'),d.created_at,d.actor,d.command->>'reason',null::jsonb,null::jsonb,'review:' || d.idempotency_key from review_decision d join extraction_run r on (r.organization_id,r.run_id)=(d.organization_id,d.run_id) where d.organization_id=${context.organizationId}
            union all select 'source',source_id,source_revision,'retry',created_at,actor,null::text,null::jsonb,null::jsonb,'retry:' || idempotency_key from processing_retry where organization_id=${context.organizationId}
            union all select 'organization',target_id,case when phase='applied' then (after->>'revision')::integer else null::integer end,action || ':' || phase,occurred_at,actor,null::text,before,after,'administration:' || operation_id || ':' || phase from organization_audit_event where organization_id=${context.organizationId}
          ) events where (${aggregateId}::text is null or aggregate_id=${aggregateId}) and (${before}::timestamptz is null or occurred_at<${before}::timestamptz) order by occurred_at desc,sort_id desc limit 100`);
          const entries: ProductAuditEntry[] = rows.rows.map((r) => ({
            aggregateType: r.aggregate_type as string,
            aggregateId: r.aggregate_id as string,
            revision:
              r.aggregate_revision == null
                ? null
                : Number(r.aggregate_revision),
            action: r.action as string,
            occurredAt: timestamp(r.occurred_at) as string,
            actor: r.actor,
            reason: r.reason as string | null,
            before: r.before,
            after: r.after,
          }));
          return { ok: true as const, value: { entries } };
        }
        if (path === "deliveries") {
          const rows =
            await tx.execute(sql`select j.id,j.need_id,j.recipient_id,j.channel,j.template,j.attempts,j.accepted_at,j.retry_after,
            case when j.accepted_at is not null then 'accepted'
            when m.id is null or m.role not in ('owner','coordinator') or n.id is null or n.revision<>j.need_revision or not coalesce((j.template='need-assigned' and ((n.status='assigned' and n.owner_membership_id=j.recipient_id) or (n.status='new' and n.urgency='urgent'))) or (j.template='need-overdue' and n.status='assigned' and n.acknowledge_by=j.need_deadline and n.acknowledge_by<=now()),false) or not coalesce((j.channel='email' and p.email) or (j.channel='telegram' and p.telegram),false) then 'obsolete'
            when j.attempts>=3 and (j.lease_until is null or j.lease_until<=now()) then 'failed' else 'pending' end as status
            from delivery_job j left join member m on (m.organization_id,m.id)=(j.organization_id,j.recipient_id) left join need n on (n.organization_id,n.id)=(j.organization_id,j.need_id) left join notification_preference p on (p.organization_id,p.membership_id)=(j.organization_id,j.recipient_id) where j.organization_id=${context.organizationId} order by j.created_at desc,j.id desc limit 100`);
          const value: DeliveryStatus[] = rows.rows.map((r) => ({
            id: r.id as string,
            needId: r.need_id as string,
            recipientId: r.recipient_id as string,
            channel: r.channel as DeliveryStatus["channel"],
            template: r.template as string,
            attempts: r.attempts as number,
            acceptedAt: timestamp(r.accepted_at),
            retryAfter: timestamp(r.retry_after),
            status: r.status as DeliveryStatus["status"],
          }));
          return { ok: true as const, value };
        }
        const rows =
          await tx.execute(sql`with latest as (select s.source_id,s.received_at,w.failed,w.attempts,w.lease_until from source_revision s left join processing_work w on (w.organization_id,w.source_id,w.source_revision)=(s.organization_id,s.source_id,s.revision) where s.organization_id=${context.organizationId} and not exists(select 1 from source_redaction z where (z.organization_id,z.source_id)=(s.organization_id,s.source_id)) and not exists(select 1 from source_revision n where n.organization_id=s.organization_id and n.source_id=s.source_id and n.revision>s.revision) and not exists(select 1 from extraction_run r where (r.organization_id,r.source_id,r.source_revision)=(s.organization_id,s.source_id,s.revision)))
          select (select count(*)::int from latest where not coalesce(failed,false) and not (coalesce(attempts,0)>=3 and (lease_until is null or lease_until<=now()))) as queued,
          (select count(*)::int from latest where coalesce(failed,false) or (coalesce(attempts,0)>=3 and (lease_until is null or lease_until<=now()))) as failed,
          (select min(received_at) from latest where not coalesce(failed,false) and not (coalesce(attempts,0)>=3 and (lease_until is null or lease_until<=now()))) as oldest,
          (select count(*)::int from need where organization_id=${context.organizationId} and urgency='urgent' and status not in ('resolved','cancelled')) as urgent,
          (select count(*)::int from need where organization_id=${context.organizationId} and status in ('new','assigned') and acknowledge_by<=now()) as overdue,
          (select count(*)::int from delivery_job j join member m on (m.organization_id,m.id)=(j.organization_id,j.recipient_id) join need n on (n.organization_id,n.id)=(j.organization_id,j.need_id) join notification_preference p on (p.organization_id,p.membership_id)=(j.organization_id,j.recipient_id) where j.organization_id=${context.organizationId} and j.accepted_at is null and j.attempts>=3 and (j.lease_until is null or j.lease_until<=now()) and m.role in ('owner','coordinator') and n.revision=j.need_revision and ((j.channel='email' and p.email) or (j.channel='telegram' and p.telegram)) and ((j.template='need-assigned' and ((n.status='assigned' and n.owner_membership_id=j.recipient_id) or (n.status='new' and n.urgency='urgent'))) or (j.template='need-overdue' and n.status='assigned' and n.acknowledge_by=j.need_deadline and n.acknowledge_by<=now()))) as deliveries,
          (select coalesce(sum(reserved_micro_usd) filter(where status in ('reserved','sent')),0)::text from model_budget_reservation where organization_id=${context.organizationId}) as reserved,
          (select coalesce(sum(actual_micro_usd) filter(where status='settled'),0)::text from model_budget_reservation where organization_id=${context.organizationId}) as settled`);
        const r = rows.rows[0];
        if (!r) return fail("DEPENDENCY_UNAVAILABLE");
        let availableStorageBytes: number | null = null;
        try {
          const disk = await statfs(attachmentRoot, { bigint: true });
          const bytes = disk.bavail * disk.bsize;
          availableStorageBytes =
            bytes <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(bytes)
              : Number.MAX_SAFE_INTEGER;
        } catch {
          /* Storage metadata may be unavailable. */
        }
        const value: OperationalStatus = {
          queuedSources: Number(r.queued),
          failedSources: Number(r.failed),
          oldestQueuedAt: timestamp(r.oldest),
          unresolvedUrgentNeeds: Number(r.urgent),
          overdueAcknowledgments: Number(r.overdue),
          failedDeliveries: Number(r.deliveries),
          modelReservedMicroUsd: Number(r.reserved),
          modelSettledMicroUsd: Number(r.settled),
          availableStorageBytes,
        };
        return { ok: true as const, value };
      });
    } catch {
      return fail("DEPENDENCY_UNAVAILABLE");
    }
  };
}
