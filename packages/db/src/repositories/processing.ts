import { createHash, randomUUID } from "node:crypto";
import {
  type ExtractionProposal,
  extractionProposalSchema,
  type Result,
  type ReviewDecision,
  type ReviewOutcome,
  type ReviewQueueEntry,
  reviewDecisionSchema,
  type SourceEnvelope,
  sourceEnvelopeSchema,
  type TenantContext,
  tenantContextSchema,
} from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

type Status = "queued" | "failed" | "review" | "accepted" | "rejected";
type SourceStatus = { sourceId: string; revision: number; status: Status };
type Executor = Pick<Database, "execute">;
const success = <T>(value: T): Result<T> => ({ ok: true, value });
function fail(
  context: TenantContext,
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
class Abort extends Error {
  readonly code: "NOT_FOUND" | "VALIDATION" | "CONFLICT";
  constructor(code: "NOT_FOUND" | "VALIDATION" | "CONFLICT", message: string) {
    super(message);
    this.code = code;
  }
}
const json = (value: unknown) => JSON.stringify(value);
const eventId = (org: string, type: string, id: string, revision = 1) =>
  `evt:${createHash("sha256")
    .update(JSON.stringify([org, type, id, revision]))
    .digest("hex")}`;
async function authorize(
  db: Executor,
  context: TenantContext,
): Promise<string | null> {
  if (
    !tenantContextSchema.safeParse(context).success ||
    context.actor.kind !== "user"
  )
    return null;
  const rows = await db.execute(
    sql`select role from member where organization_id = ${context.organizationId} and id = ${context.actor.membershipId} and user_id = ${context.actor.userId} for share`,
  );
  return (rows.rows[0]?.role as string | undefined) ?? null;
}
const staff = (role: string | null) =>
  role === "owner" || role === "coordinator";
function validEvidence(
  proposal: ExtractionProposal,
  source: SourceEnvelope,
): boolean {
  const keys = new Set<string>();
  for (const item of proposal.items) {
    if (keys.has(item.key)) return false;
    keys.add(item.key);
    for (const evidence of item.evidence) {
      if (
        evidence.sourceId !== source.sourceId ||
        evidence.sourceRevision !== source.revision
      )
        return false;
      if (
        evidence.kind === "text" &&
        source.text.slice(evidence.start, evidence.end) !== evidence.quote
      )
        return false;
      if (
        evidence.kind === "attachment" &&
        !source.attachments.some(
          (attachment) => attachment.id === evidence.attachmentId,
        )
      )
        return false;
    }
  }
  return true;
}

/** Durable processing and human review. Worker-only methods are internal server APIs. */
export function createProcessingRepository(db: Database) {
  return {
    async persistProposal(
      context: TenantContext,
      supplied: SourceEnvelope,
      proposal: ExtractionProposal,
      leaseToken: string,
    ): Promise<Result<void>> {
      if (
        !tenantContextSchema.safeParse(context).success ||
        context.actor.kind !== "system" ||
        context.actor.service !== "worker"
      )
        return fail(context, "FORBIDDEN", "Worker authority required");
      if (
        !sourceEnvelopeSchema.safeParse(supplied).success ||
        !extractionProposalSchema.safeParse(proposal).success ||
        proposal.organizationId !== context.organizationId ||
        supplied.organizationId !== context.organizationId ||
        proposal.sourceId !== supplied.sourceId ||
        proposal.sourceRevision !== supplied.revision
      )
        return fail(context, "VALIDATION", "Invalid proposal identity");
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select id from source where organization_id = ${context.organizationId} and id = ${supplied.sourceId} for update`,
          );
          const rows = await tx.execute(
            sql`select envelope from source_revision where organization_id = ${context.organizationId} and source_id = ${supplied.sourceId} order by revision desc limit 1`,
          );
          const stored = rows.rows[0]?.envelope as SourceEnvelope | undefined;
          if (!stored || stored.revision !== supplied.revision)
            throw new Abort("CONFLICT", "Source revision is stale");
          if (!equal(stored, supplied) || !validEvidence(proposal, stored))
            throw new Abort("VALIDATION", "Proposal evidence is invalid");
          const prior = await tx.execute(
            sql`select proposal from extraction_run where organization_id = ${context.organizationId} and (run_id = ${proposal.runId} or (source_id = ${proposal.sourceId} and source_revision = ${proposal.sourceRevision}))`,
          );
          if (prior.rows.length) {
            if (equal(prior.rows[0]?.proposal, proposal)) return;
            throw new Abort("CONFLICT", "Proposal already exists");
          }
          const lease = await tx.execute(
            sql`select 1 from processing_work where organization_id=${context.organizationId} and source_id=${proposal.sourceId} and source_revision=${proposal.sourceRevision} and lease_until > now() and lease_token=${leaseToken} for update`,
          );
          if (!lease.rows.length)
            throw new Abort("CONFLICT", "Source is not leased for processing");
          await tx.execute(
            sql`insert into extraction_run (organization_id,run_id,source_id,source_revision,proposal) values (${context.organizationId},${proposal.runId},${proposal.sourceId},${proposal.sourceRevision},${json(proposal)}::jsonb)`,
          );
          await tx.execute(
            sql`delete from processing_work where organization_id = ${context.organizationId} and source_id = ${proposal.sourceId} and source_revision = ${proposal.sourceRevision}`,
          );
        });
        return success(undefined);
      } catch (error) {
        return error instanceof Abort
          ? fail(context, error.code, error.message)
          : fail(
              context,
              "DEPENDENCY_UNAVAILABLE",
              "Processing storage unavailable",
            );
      }
    },
    async listQueue(
      context: TenantContext,
    ): Promise<Result<ReviewQueueEntry[]>> {
      try {
        if (!staff(await authorize(db, context)))
          return fail(context, "FORBIDDEN", "Review authority required");
        const rows = await db.execute(
          sql`select r.proposal, r.revision, s.envelope from extraction_run r join source_revision s on (s.organization_id,s.source_id,s.revision)=(r.organization_id,r.source_id,r.source_revision) where r.organization_id=${context.organizationId} and r.status='review' and not exists (select 1 from source_revision newer where newer.organization_id=r.organization_id and newer.source_id=r.source_id and newer.revision>r.source_revision) order by r.created_at,r.run_id`,
        );
        return success(
          rows.rows.map((row) => ({
            schemaVersion: 1,
            source: row.envelope as SourceEnvelope,
            proposal: row.proposal as ExtractionProposal,
            revision: row.revision as number,
          })),
        );
      } catch {
        return fail(
          context,
          "DEPENDENCY_UNAVAILABLE",
          "Processing storage unavailable",
        );
      }
    },
    async getSource(
      context: TenantContext,
      sourceId: string,
    ): Promise<Result<SourceEnvelope>> {
      try {
        const role = await authorize(db, context);
        if (!staff(role) && role !== "volunteer")
          return fail(context, "FORBIDDEN", "Source authority required");
        const rows = await db.execute(
          sql`select envelope,author_membership_id from source_revision where organization_id=${context.organizationId} and source_id=${sourceId} order by revision desc limit 1`,
        );
        const row = rows.rows[0];
        if (
          !row ||
          (!staff(role) &&
            (context.actor.kind !== "user" ||
              row.author_membership_id !== context.actor.membershipId))
        )
          return fail(context, "NOT_FOUND", "Source not found");
        return success(row.envelope as SourceEnvelope);
      } catch {
        return fail(
          context,
          "DEPENDENCY_UNAVAILABLE",
          "Processing storage unavailable",
        );
      }
    },
    async listSourceStatuses(
      context: TenantContext,
    ): Promise<Result<SourceStatus[]>> {
      try {
        const role = await authorize(db, context);
        if (!staff(role) && role !== "volunteer")
          return fail(context, "FORBIDDEN", "Source authority required");
        const actorId =
          context.actor.kind === "user" ? context.actor.membershipId : "";
        const rows = await db.execute(
          sql`select s.source_id,s.revision,coalesce(r.status,case when w.failed then 'failed' else 'queued' end) as status from source_revision s left join extraction_run r on (r.organization_id,r.source_id,r.source_revision)=(s.organization_id,s.source_id,s.revision) left join processing_work w on (w.organization_id,w.source_id,w.source_revision)=(s.organization_id,s.source_id,s.revision) where s.organization_id=${context.organizationId} and (${staff(role)} or s.author_membership_id=${actorId}) and not exists (select 1 from source_revision n where n.organization_id=s.organization_id and n.source_id=s.source_id and n.revision>s.revision) order by s.received_at desc,s.source_id`,
        );
        return success(
          rows.rows.map((row) => ({
            sourceId: row.source_id as string,
            revision: row.revision as number,
            status: row.status as Status,
          })),
        );
      } catch {
        return fail(
          context,
          "DEPENDENCY_UNAVAILABLE",
          "Processing storage unavailable",
        );
      }
    },
    async pendingSources(
      limit: number,
    ): Promise<Array<{ source: SourceEnvelope; leaseToken: string }>> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid processing limit");
      return db
        .transaction(async (tx) => {
          await tx.execute(
            sql`update processing_work set failed=true,lease_until=null,lease_token=null where attempts=3 and lease_until<=now()`,
          );
          await tx.execute(
            sql`insert into processing_work (organization_id,source_id,source_revision) select s.organization_id,s.source_id,s.revision from source_revision s where not exists (select 1 from source_revision n where n.organization_id=s.organization_id and n.source_id=s.source_id and n.revision>s.revision) and not exists (select 1 from extraction_run r where r.organization_id=s.organization_id and r.source_id=s.source_id and r.source_revision=s.revision) on conflict do nothing`,
          );
          const rows = await tx.execute(
            sql`with picked as (select w.organization_id,w.source_id,w.source_revision from processing_work w where w.attempts<3 and (w.lease_until is null or w.lease_until<=now()) and (w.retry_after is null or w.retry_after<=now()) and not exists (select 1 from source_revision n where n.organization_id=w.organization_id and n.source_id=w.source_id and n.revision>w.source_revision) order by w.source_id for update skip locked limit ${limit}), leased as (update processing_work w set attempts=w.attempts+1,lease_token=gen_random_uuid()::text,lease_until=now()+interval '5 minutes',failed=false from picked p where (w.organization_id,w.source_id,w.source_revision)=(p.organization_id,p.source_id,p.source_revision) returning w.*) select s.envelope,w.lease_token from leased w join source_revision s on (s.organization_id,s.source_id,s.revision)=(w.organization_id,w.source_id,w.source_revision)`,
          );
          return rows.rows.map((row) => ({
            source: row.envelope as SourceEnvelope,
            leaseToken: row.lease_token as string,
          }));
        })
        .catch(() => {
          throw new Error("Processing storage unavailable");
        });
    },
    async markFailure(
      source: SourceEnvelope,
      leaseToken: string,
    ): Promise<void> {
      await db
        .execute(
          sql`update processing_work set failed=true,lease_until=null,lease_token=null,retry_after=now() + (power(2,attempts) * interval '1 minute') where organization_id=${source.organizationId} and source_id=${source.sourceId} and source_revision=${source.revision} and lease_until > now() and lease_token=${leaseToken}`,
        )
        .catch(() => {
          throw new Error("Processing storage unavailable");
        });
    },
    async decide(
      context: TenantContext,
      command: ReviewDecision,
    ): Promise<Result<ReviewOutcome>> {
      if (!reviewDecisionSchema.safeParse(command).success)
        return fail(context, "VALIDATION", "Invalid review decision");
      try {
        return await db.transaction(
          async (tx): Promise<Result<ReviewOutcome>> => {
            if (!staff(await authorize(tx, context)))
              return fail(context, "FORBIDDEN", "Review authority required");
            // Serialize identical idempotency keys across concurrent reviewers.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${json([context.organizationId, command.idempotencyKey])}, 0))`,
            );
            const prior = await tx.execute(
              sql`select command,outcome from review_decision where organization_id=${context.organizationId} and idempotency_key=${command.idempotencyKey}`,
            );
            if (prior.rows[0])
              return equal(prior.rows[0].command, command)
                ? success(prior.rows[0].outcome as ReviewOutcome)
                : fail(context, "CONFLICT", "Idempotency key already used");
            const found = await tx.execute(
              sql`select source_id from extraction_run where organization_id=${context.organizationId} and run_id=${command.runId}`,
            );
            if (!found.rows[0])
              return fail(context, "NOT_FOUND", "Review not found");
            const sourceId = found.rows[0].source_id as string;
            await tx.execute(
              sql`select id from source where organization_id=${context.organizationId} and id=${sourceId} for update`,
            );
            const rows = await tx.execute(
              sql`select r.*,s.envelope from extraction_run r join source_revision s on (s.organization_id,s.source_id,s.revision)=(r.organization_id,r.source_id,r.source_revision) where r.organization_id=${context.organizationId} and r.run_id=${command.runId} for update of r`,
            );
            const row = rows.rows[0];
            if (!row) throw new Abort("NOT_FOUND", "Review not found");
            if (
              row.status !== "review" ||
              row.revision !== command.expectedRevision
            )
              throw new Abort("CONFLICT", "Review revision changed");
            const latest = await tx.execute(
              sql`select max(revision) as revision from source_revision where organization_id=${context.organizationId} and source_id=${sourceId}`,
            );
            if (latest.rows[0]?.revision !== row.source_revision)
              throw new Abort("CONFLICT", "Source revision is stale");
            const original = row.proposal as ExtractionProposal;
            const source = row.envelope as SourceEnvelope;
            if (
              !extractionProposalSchema.safeParse(original).success ||
              !validEvidence(original, source)
            )
              throw new Abort("VALIDATION", "Stored proposal is invalid");
            const proposal = {
              ...original,
              items: command.replacementItems ?? original.items,
            };
            if (!validEvidence(proposal, source))
              throw new Abort(
                "VALIDATION",
                "Edited proposal evidence is invalid",
              );
            const editReason =
              command.replacementItems === undefined ? null : command.reason;
            if (command.decision === "accept") {
              const corrections = proposal.items.filter(
                (item) => item.kind === "correction",
              );
              const priorRun = await tx.execute(
                sql`select r.run_id,r.proposal,d.command from extraction_run r join review_decision d on (d.organization_id,d.run_id)=(r.organization_id,r.run_id) where r.organization_id=${context.organizationId} and r.source_id=${sourceId} and r.source_revision<${source.revision} and r.status='accepted' order by r.source_revision desc limit 1`,
              );
              if (corrections.length > 0) {
                if (corrections.length !== proposal.items.length)
                  throw new Abort(
                    "CONFLICT",
                    "Corrections cannot be mixed with new records",
                  );
                const targets = new Set<string>();
                for (const item of corrections) {
                  if (
                    item.kind !== "correction" ||
                    !item.targetId ||
                    !item.expectedRevision ||
                    targets.has(item.targetId) ||
                    (item.durationMinutes !== null &&
                      item.durationMinutes > 1440) ||
                    !item.reason.trim()
                  )
                    throw new Abort("VALIDATION", "Invalid correction");
                  targets.add(item.targetId);
                  const result = await correctContribution(
                    tx,
                    context,
                    item.targetId,
                    item.expectedRevision,
                    item.durationMinutes,
                    item.reason,
                    new Date(),
                  );
                  await addEffect(
                    tx,
                    context.organizationId,
                    command.runId,
                    item.key,
                    "contribution",
                    item.targetId,
                    result,
                  );
                }
              } else if (priorRun.rows[0]) {
                await reconcile(
                  tx,
                  context,
                  command.runId,
                  proposal,
                  priorRun.rows[0],
                  editReason,
                );
              } else {
                const activities = new Map<string, string>();
                const participants = new Set<string>();
                for (const item of proposal.items) {
                  if (item.kind === "activity") {
                    if (
                      (item.localDate === null) !==
                      (item.datePrecision === "unknown")
                    )
                      throw new Abort("VALIDATION", "Invalid activity date");
                    activities.set(item.key, randomUUID());
                  }
                }
                for (const item of proposal.items) {
                  if (item.kind !== "contribution") continue;
                  if (
                    !activities.has(item.activityKey) ||
                    (item.durationMinutes !== null &&
                      item.durationMinutes > 1440)
                  )
                    throw new Abort("VALIDATION", "Invalid contribution");
                  if (item.membershipId !== null) {
                    const key = json([item.activityKey, item.membershipId]);
                    if (participants.has(key))
                      throw new Abort("VALIDATION", "Duplicate contribution");
                    participants.add(key);
                    const member = await tx.execute(
                      sql`select id from member where organization_id=${context.organizationId} and id=${item.membershipId} for key share`,
                    );
                    if (!member.rows.length)
                      throw new Abort(
                        "VALIDATION",
                        "Contribution membership unavailable",
                      );
                    await tx.execute(
                      sql`insert into source_author (organization_id,membership_id,current_membership_id) values (${context.organizationId},${item.membershipId},${item.membershipId}) on conflict (organization_id,membership_id) do update set current_membership_id=excluded.current_membership_id`,
                    );
                  }
                }
                const now = new Date();
                const timestamp = now.toISOString();
                const origin = {
                  kind: "source",
                  sourceId,
                  sourceRevision: source.revision,
                };
                for (const item of proposal.items) {
                  if (item.kind === "activity") {
                    const id = activities.get(item.key) as string;
                    const record = {
                      schemaVersion: 1,
                      organizationId: context.organizationId,
                      activityId: id,
                      revision: 1,
                      kind: item.activityKind,
                      localDate: item.localDate,
                      datePrecision: item.datePrecision,
                      beneficiaryReference: item.beneficiaryReference,
                      origin,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    };
                    await tx.execute(
                      sql`insert into activity (organization_id,id,revision,kind,local_date,date_precision,beneficiary_reference,origin_kind,origin_source_id,origin_source_revision,created_at,updated_at) values (${context.organizationId},${id},1,${item.activityKind},${item.localDate},${item.datePrecision},${item.beneficiaryReference},'source',${sourceId},${source.revision},${now},${now})`,
                    );
                    await audit(
                      tx,
                      context,
                      "activity",
                      id,
                      record,
                      now,
                      editReason,
                    );
                    await addEffect(
                      tx,
                      context.organizationId,
                      command.runId,
                      item.key,
                      "activity",
                      id,
                      1,
                    );
                  } else if (item.kind === "contribution") {
                    const id = randomUUID();
                    const activityId = activities.get(
                      item.activityKey,
                    ) as string;
                    const status =
                      item.membershipId !== null &&
                      item.durationMinutes !== null
                        ? "approved"
                        : "pending";
                    const record = {
                      schemaVersion: 1,
                      organizationId: context.organizationId,
                      contributionId: id,
                      activityId,
                      revision: 1,
                      membershipId: item.membershipId,
                      durationMinutes: item.durationMinutes,
                      status,
                      origin,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    };
                    await tx.execute(
                      sql`insert into contribution (organization_id,id,revision,activity_id,membership_id,duration_minutes,status,origin_kind,origin_source_id,origin_source_revision,created_at,updated_at) values (${context.organizationId},${id},1,${activityId},${item.membershipId},${item.durationMinutes},${status},'source',${sourceId},${source.revision},${now},${now})`,
                    );
                    await audit(
                      tx,
                      context,
                      "contribution",
                      id,
                      record,
                      now,
                      editReason,
                    );
                    await addEffect(
                      tx,
                      context.organizationId,
                      command.runId,
                      item.key,
                      "contribution",
                      id,
                      1,
                    );
                    if (status === "approved")
                      await event(
                        tx,
                        context,
                        "ledger.changed",
                        id,
                        { contributionId: id, reason: "approved" },
                        now,
                      );
                  } else if (item.kind === "need") {
                    const id = randomUUID();
                    const record = {
                      schemaVersion: 1,
                      organizationId: context.organizationId,
                      needId: id,
                      revision: 1,
                      category: item.category,
                      urgency: item.urgency,
                      summary: item.summary,
                      provisional: item.provisional,
                      status: "new",
                      ownerMembershipId: null,
                      dueAt: null,
                      acknowledgeBy: null,
                      acknowledgedAt: null,
                      acknowledgedByMembershipId: null,
                      resolvedAt: null,
                      resolution: null,
                      origin,
                      createdAt: timestamp,
                      updatedAt: timestamp,
                    };
                    await tx.execute(
                      sql`insert into need (organization_id,id,revision,category,urgency,summary,provisional,status,origin_kind,origin_source_id,origin_source_revision,created_at,updated_at) values (${context.organizationId},${id},1,${item.category},${item.urgency},${item.summary},${item.provisional},'new','source',${sourceId},${source.revision},${now},${now})`,
                    );
                    await audit(
                      tx,
                      context,
                      "need",
                      id,
                      record,
                      now,
                      editReason,
                    );
                    await addEffect(
                      tx,
                      context.organizationId,
                      command.runId,
                      item.key,
                      "need",
                      id,
                      1,
                    );
                    await event(
                      tx,
                      context,
                      "need.changed",
                      id,
                      {
                        needId: id,
                        status: "new",
                        provisional: item.provisional,
                      },
                      now,
                    );
                  }
                }
              }
            }
            const outcome = { revision: command.expectedRevision + 1 };
            await tx.execute(
              sql`update extraction_run set status=${command.decision === "accept" ? "accepted" : "rejected"},revision=${outcome.revision} where organization_id=${context.organizationId} and run_id=${command.runId}`,
            );
            await tx.execute(
              sql`insert into review_decision (organization_id,idempotency_key,run_id,command,outcome,actor,correlation_id) values (${context.organizationId},${command.idempotencyKey},${command.runId},${json(command)}::jsonb,${json(outcome)}::jsonb,${json(context.actor)}::jsonb,${context.correlationId})`,
            );
            return success(outcome);
          },
        );
      } catch (error) {
        return error instanceof Abort
          ? fail(context, error.code, error.message)
          : fail(
              context,
              "DEPENDENCY_UNAVAILABLE",
              "Processing storage unavailable",
            );
      }
    },
  };
}
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sorted(entry)]),
    );
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  return json(sorted(a)) === json(sorted(b));
}
async function audit(
  tx: Executor,
  context: TenantContext,
  type: string,
  id: string,
  record: unknown,
  now: Date,
  reason: string | null,
) {
  await tx.execute(
    sql`insert into domain_audit_event (organization_id,id,aggregate_type,aggregate_id,aggregate_revision,action,actor,correlation_id,reason,before,after,occurred_at) values (${context.organizationId},${`${type}:${id}:1`},${type},${id},1,'created',${json(context.actor)}::jsonb,${context.correlationId},${reason},null,${json(record)}::jsonb,${now})`,
  );
}
async function event(
  tx: Executor,
  context: TenantContext,
  type: string,
  id: string,
  payload: unknown,
  now: Date,
  revision = 1,
) {
  await tx.execute(
    sql`insert into outbox_event (organization_id,id,type,aggregate_id,aggregate_revision,payload,actor,correlation_id,occurred_at) values (${context.organizationId},${eventId(context.organizationId, type, id, revision)},${type},${id},${revision},${json(payload)}::jsonb,${json(context.actor)}::jsonb,${context.correlationId},${now})`,
  );
}

async function addEffect(
  tx: Executor,
  organizationId: string,
  runId: string,
  key: string,
  kind: string,
  id: string,
  revision: number,
) {
  await tx.execute(
    sql`insert into review_effect (organization_id,run_id,item_key,kind,aggregate_id,aggregate_revision) values (${organizationId},${runId},${key},${kind},${id},${revision})`,
  );
}

type ContributionSnapshot = {
  revision: number;
  durationMinutes: number | null;
  status: string;
  updatedAt: string;
  [key: string]: unknown;
};
async function correctContribution(
  tx: Executor,
  context: TenantContext,
  id: string,
  expectedRevision: number,
  duration: number | null,
  reason: string,
  now: Date,
): Promise<number> {
  const rows = await tx.execute(
    sql`select c.revision,c.status,c.duration_minutes,a.after from contribution c left join domain_audit_event a on a.organization_id=c.organization_id and a.aggregate_type='contribution' and a.aggregate_id=c.id and a.aggregate_revision=c.revision where c.organization_id=${context.organizationId} and c.id=${id} for update of c`,
  );
  const row = rows.rows[0];
  if (!row) throw new Abort("VALIDATION", "Correction target unavailable");
  if (
    row.revision !== expectedRevision ||
    !["pending", "approved"].includes(row.status as string)
  )
    throw new Abort("CONFLICT", "Contribution revision changed");
  if (row.status === "approved" && duration === null)
    throw new Abort(
      "VALIDATION",
      "Approved contribution needs a known duration",
    );
  const before = row.after as ContributionSnapshot | undefined;
  if (!before || before.revision !== expectedRevision)
    throw new Abort("CONFLICT", "Contribution history unavailable");
  const revision = expectedRevision + 1;
  const after = {
    ...before,
    revision,
    durationMinutes: duration,
    updatedAt: now.toISOString(),
  };
  await tx.execute(
    sql`update contribution set revision=${revision},duration_minutes=${duration},updated_at=${now} where organization_id=${context.organizationId} and id=${id} and revision=${expectedRevision}`,
  );
  await tx.execute(
    sql`insert into domain_audit_event (organization_id,id,aggregate_type,aggregate_id,aggregate_revision,action,actor,correlation_id,reason,before,after,occurred_at) values (${context.organizationId},${`contribution:${id}:${revision}`},'contribution',${id},${revision},'corrected',${json(context.actor)}::jsonb,${context.correlationId},${reason},${json(before)}::jsonb,${json(after)}::jsonb,${now})`,
  );
  if (row.status === "approved" && row.duration_minutes !== duration)
    await event(
      tx,
      context,
      "ledger.changed",
      id,
      { contributionId: id, reason: "corrected" },
      now,
      revision,
    );
  return revision;
}

type Effect = {
  item_key: string;
  kind: string;
  aggregate_id: string;
  aggregate_revision: number;
};
async function reconcile(
  tx: Executor,
  context: TenantContext,
  runId: string,
  proposal: ExtractionProposal,
  previous: Record<string, unknown>,
  reason: string | null,
): Promise<void> {
  const previousProposal = previous.proposal as ExtractionProposal;
  const previousCommand = previous.command as ReviewDecision;
  const oldItems = previousCommand.replacementItems ?? previousProposal.items;
  const effectsResult = await tx.execute(
    sql`select item_key,kind,aggregate_id,aggregate_revision from review_effect where organization_id=${context.organizationId} and run_id=${previous.run_id as string}`,
  );
  const effects = effectsResult.rows as Effect[];
  if (
    oldItems.length !== proposal.items.length ||
    effects.length !== oldItems.length
  )
    throw new Abort(
      "CONFLICT",
      "Prior review cannot be reconciled automatically",
    );
  const previousItems = new Map(oldItems.map((item) => [item.key, item]));
  const effectByKey = new Map(
    effects.map((effect) => [effect.item_key, effect]),
  );
  for (const item of proposal.items) {
    const prior = previousItems.get(item.key);
    const effect = effectByKey.get(item.key);
    if (
      !prior ||
      !effect ||
      prior.kind !== item.kind ||
      effect.kind !== item.kind ||
      item.kind === "correction" ||
      prior.kind === "correction"
    )
      throw new Abort("CONFLICT", "Source revision changes its structure");
    const { evidence: _evidence, ...newFields } = item;
    const { evidence: _oldEvidence, ...oldFields } = prior;
    if (item.kind === "contribution" && prior.kind === "contribution") {
      if (
        item.activityKey !== prior.activityKey ||
        item.membershipId !== prior.membershipId ||
        (item.durationMinutes !== null && item.durationMinutes > 1440)
      )
        throw new Abort("CONFLICT", "Contribution identity changed");
    } else if (!equal(newFields, oldFields))
      throw new Abort("CONFLICT", "Source revision changes its structure");
    const table =
      item.kind === "activity"
        ? "activity"
        : item.kind === "need"
          ? "need"
          : "contribution";
    const current = await tx.execute(
      sql`select revision from ${sql.identifier(table)} where organization_id=${context.organizationId} and id=${effect.aggregate_id} for update`,
    );
    if (current.rows[0]?.revision !== effect.aggregate_revision)
      throw new Abort("CONFLICT", "Previously reviewed record changed");
    let revision = effect.aggregate_revision;
    if (
      item.kind === "contribution" &&
      prior.kind === "contribution" &&
      item.durationMinutes !== prior.durationMinutes
    ) {
      revision = await correctContribution(
        tx,
        context,
        effect.aggregate_id,
        revision,
        item.durationMinutes,
        reason ?? `Source revision ${proposal.sourceRevision}`,
        new Date(),
      );
    }
    await addEffect(
      tx,
      context.organizationId,
      runId,
      item.key,
      item.kind,
      effect.aggregate_id,
      revision,
    );
  }
}
