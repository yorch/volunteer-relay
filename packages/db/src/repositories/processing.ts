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
  async function executeDecision(
    context: TenantContext,
    command: ReviewDecision,
    automaticSource?: SourceEnvelope,
  ): Promise<Result<ReviewOutcome>> {
    if (!reviewDecisionSchema.safeParse(command).success)
      return fail(context, "VALIDATION", "Invalid review decision");
    try {
      return await db.transaction(
        async (tx): Promise<Result<ReviewOutcome>> => {
          if (!automaticSource && !staff(await authorize(tx, context)))
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
          const currentGeneration = await tx.execute(
            sql`select max(generation)::int as generation from processing_policy_snapshot where organization_id=${context.organizationId} and source_id=${sourceId} and source_revision=${row.source_revision as number}`,
          );
          if (currentGeneration.rows[0]?.generation !== row.generation)
            throw new Abort("CONFLICT", "Review generation is stale");
          const original = row.proposal as ExtractionProposal;
          const source = row.envelope as SourceEnvelope;
          if (
            !extractionProposalSchema.safeParse(original).success ||
            !validEvidence(original, source)
          )
            throw new Abort("VALIDATION", "Stored proposal is invalid");
          if (automaticSource) {
            if (!equal(automaticSource, source))
              throw new Abort("CONFLICT", "Automatic source changed");
            await requireValidatedPolicy(
              tx,
              context.organizationId,
              original,
              source,
              row.generation as number,
            );
          }
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
          if (
            command.activityLinks !== undefined &&
            (command.decision !== "accept" || !command.reason.trim())
          )
            throw new Abort(
              "VALIDATION",
              "Activity links require a staff reason",
            );
          if (command.decision === "accept") {
            const links = command.activityLinks ?? {};
            const activityKeys = proposal.items
              .filter((item) => item.kind === "activity")
              .map((item) => item.key);
            if (Object.keys(links).some((key) => !activityKeys.includes(key)))
              throw new Abort("VALIDATION", "Activity link key is invalid");
            if (
              new Set(Object.values(links).map((link) => link.activityId))
                .size !== Object.keys(links).length
            )
              throw new Abort("VALIDATION", "Activity links must be distinct");
            if (
              proposal.unresolved.some(
                (item) => item.field === "duplicateCandidate",
              ) &&
              (activityKeys.length === 0 ||
                activityKeys.some((key) => !Object.hasOwn(links, key)))
            )
              throw new Abort(
                "CONFLICT",
                "Duplicate candidate requires an explicit activity link",
              );
            const corrections = proposal.items.filter(
              (item) => item.kind === "correction",
            );
            const priorRun = await tx.execute(
              sql`select r.run_id,r.proposal,d.command from extraction_run r join review_decision d on (d.organization_id,d.run_id)=(r.organization_id,r.run_id) where r.organization_id=${context.organizationId} and r.source_id=${sourceId} and (r.source_revision<${source.revision} or (r.source_revision=${source.revision} and r.generation<${row.generation as number})) and r.status='accepted' order by r.source_revision desc,r.generation desc limit 1`,
            );
            if (
              Object.keys(links).length > 0 &&
              (corrections.length > 0 || priorRun.rows[0])
            )
              throw new Abort(
                "CONFLICT",
                "Activity links require a new source review",
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
                const lineage = await tx.execute(
                  sql`select 1 from review_effect e join extraction_run r on (r.organization_id,r.run_id)=(e.organization_id,e.run_id) where e.organization_id=${context.organizationId} and r.source_id=${sourceId} and r.source_revision<${source.revision} and r.status='accepted' and e.kind='contribution' and e.aggregate_id=${item.targetId} and e.aggregate_revision=${item.expectedRevision} limit 1`,
                );
                if (
                  !lineage.rows.length &&
                  (command.replacementItems === undefined ||
                    !command.reason.trim())
                )
                  throw new Abort(
                    "CONFLICT",
                    "Correction requires explicit staff authorization",
                  );
                const auditReason = json({
                  sourceId,
                  sourceRevision: source.revision,
                  staffReason: command.reason,
                  proposalReason: item.reason,
                });
                const result = await correctContribution(
                  tx,
                  context,
                  item.targetId,
                  item.expectedRevision,
                  item.durationMinutes,
                  auditReason,
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
                  const link = links[item.key];
                  activities.set(
                    item.key,
                    link ? link.activityId : randomUUID(),
                  );
                }
              }
              for (const item of proposal.items) {
                if (item.kind !== "contribution") continue;
                if (
                  !activities.has(item.activityKey) ||
                  (item.durationMinutes !== null && item.durationMinutes > 1440)
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
              for (const [key, link] of Object.entries(links).sort(([a], [b]) =>
                a.localeCompare(b),
              )) {
                const rows = await tx.execute(
                  sql`select revision from activity where organization_id=${context.organizationId} and id=${link.activityId} for update`,
                );
                if (!rows.rows.length)
                  throw new Abort("VALIDATION", "Linked activity unavailable");
                if (rows.rows[0]?.revision !== link.expectedRevision)
                  throw new Abort(
                    "CONFLICT",
                    "Linked activity revision changed",
                  );
                if (!activities.has(key))
                  throw new Abort("VALIDATION", "Activity link key is invalid");
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
                  const link = links[item.key];
                  if (link) {
                    await addEffect(
                      tx,
                      context.organizationId,
                      command.runId,
                      item.key,
                      "activity",
                      id,
                      link.expectedRevision,
                    );
                    continue;
                  }
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
                  const activityId = activities.get(item.activityKey) as string;
                  if (links[item.activityKey] && item.membershipId !== null) {
                    const existing = await tx.execute(
                      sql`select id,revision,duration_minutes from contribution where organization_id=${context.organizationId} and activity_id=${activityId} and membership_id=${item.membershipId} and status in ('pending','approved') for update`,
                    );
                    if (existing.rows[0]) {
                      if (
                        existing.rows[0].duration_minutes !==
                        item.durationMinutes
                      )
                        throw new Abort(
                          "CONFLICT",
                          "Existing contribution duration differs; use a correction",
                        );
                      await addEffect(
                        tx,
                        context.organizationId,
                        command.runId,
                        item.key,
                        "contribution",
                        existing.rows[0].id as string,
                        existing.rows[0].revision as number,
                      );
                      continue;
                    }
                  }
                  const id = randomUUID();
                  const status =
                    item.membershipId !== null && item.durationMinutes !== null
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
                  const provisional = await tx.execute(
                    sql`select need_id from provisional_need where organization_id=${context.organizationId} and run_id=${command.runId} and item_key_hash=${itemKeyHash(item.key)}`,
                  );
                  if (provisional.rows[0]) {
                    const id = provisional.rows[0].need_id as string;
                    const revision = await updateProvisional(
                      tx,
                      context,
                      id,
                      "confirm",
                      item,
                      command.reason,
                    );
                    await addEffect(
                      tx,
                      context.organizationId,
                      command.runId,
                      item.key,
                      "need",
                      id,
                      revision,
                    );
                    continue;
                  }
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
                  await audit(tx, context, "need", id, record, now, editReason);
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
          const keep =
            command.decision === "accept"
              ? proposal.items
                  .filter((item) => item.kind === "need")
                  .map((item) => itemKeyHash(item.key))
              : [];
          await withdrawRemainingProvisional(
            tx,
            context,
            command.runId,
            keep,
            command.reason,
          );
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
  }
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
          const tombstone = await tx.execute(
            sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${supplied.sourceId}`,
          );
          if (tombstone.rows.length)
            throw new Abort("NOT_FOUND", "Source not found");
          const stored = rows.rows[0]?.envelope as SourceEnvelope | undefined;
          if (!stored || stored.revision !== supplied.revision)
            throw new Abort("CONFLICT", "Source revision is stale");
          if (!equal(stored, supplied) || !validEvidence(proposal, stored))
            throw new Abort("VALIDATION", "Proposal evidence is invalid");
          const prior = await tx.execute(
            sql`select r.proposal,r.generation,(select max(p.generation) from processing_policy_snapshot p where p.organization_id=r.organization_id and p.source_id=r.source_id and p.source_revision=r.source_revision) as current_generation from extraction_run r where r.organization_id=${context.organizationId} and r.run_id=${proposal.runId}`,
          );
          if (prior.rows.length) {
            if (
              prior.rows[0]?.generation === prior.rows[0]?.current_generation &&
              equal(prior.rows[0]?.proposal, proposal)
            )
              return;
            throw new Abort("CONFLICT", "Proposal already exists");
          }
          const lease = await tx.execute(
            sql`select w.generation,p.policy_version from processing_work w join processing_policy_snapshot p on (p.organization_id,p.source_id,p.source_revision,p.generation)=(w.organization_id,w.source_id,w.source_revision,w.generation) where w.organization_id=${context.organizationId} and w.source_id=${proposal.sourceId} and w.source_revision=${proposal.sourceRevision} and w.lease_until > now() and w.lease_token=${leaseToken} for update of w`,
          );
          if (!lease.rows.length)
            throw new Abort("CONFLICT", "Source is not leased for processing");
          const generation = lease.rows[0]?.generation as number;
          if (lease.rows[0]?.policy_version !== proposal.policyVersion)
            throw new Abort(
              "VALIDATION",
              "Proposal policy version does not match its intake snapshot",
            );
          const occupied = await tx.execute(
            sql`select 1 from extraction_run where organization_id=${context.organizationId} and source_id=${proposal.sourceId} and source_revision=${proposal.sourceRevision} and generation=${generation}`,
          );
          if (occupied.rows.length)
            throw new Abort(
              "CONFLICT",
              "Processing generation already has a proposal",
            );
          await withdrawEarlierProvisional(tx, context, proposal, generation);
          await tx.execute(
            sql`insert into extraction_run (organization_id,run_id,source_id,source_revision,generation,proposal) values (${context.organizationId},${proposal.runId},${proposal.sourceId},${proposal.sourceRevision},${generation},${json(proposal)}::jsonb)`,
          );
          await createProvisionalNeeds(
            tx,
            context,
            sourceEnvelopeSchema.parse(stored),
            proposal,
            generation,
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
          sql`select r.proposal, r.revision, s.envelope from extraction_run r join source_revision s on (s.organization_id,s.source_id,s.revision)=(r.organization_id,r.source_id,r.source_revision) where r.organization_id=${context.organizationId} and r.status='review' and r.generation=(select max(p.generation) from processing_policy_snapshot p where p.organization_id=r.organization_id and p.source_id=r.source_id and p.source_revision=r.source_revision) and not exists (select 1 from source_redaction z where z.organization_id=r.organization_id and z.source_id=r.source_id) and not exists (select 1 from source_revision newer where newer.organization_id=r.organization_id and newer.source_id=r.source_id and newer.revision>r.source_revision) order by r.created_at,r.run_id`,
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
        const redacted = await db.execute(
          sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${sourceId}`,
        );
        if (redacted.rows.length)
          return fail(context, "NOT_FOUND", "Source not found");
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
          sql`select s.source_id,s.revision,coalesce(r.status,case when w.failed or (w.attempts>=3 and (w.lease_until is null or w.lease_until<=now())) then 'failed' else 'queued' end) as status from source_revision s left join extraction_run r on (r.organization_id,r.source_id,r.source_revision)=(s.organization_id,s.source_id,s.revision) and r.generation=(select max(p.generation) from processing_policy_snapshot p where p.organization_id=s.organization_id and p.source_id=s.source_id and p.source_revision=s.revision) left join processing_work w on (w.organization_id,w.source_id,w.source_revision)=(s.organization_id,s.source_id,s.revision) where s.organization_id=${context.organizationId} and not exists (select 1 from source_redaction z where z.organization_id=s.organization_id and z.source_id=s.source_id) and (${staff(role)} or s.author_membership_id=${actorId}) and not exists (select 1 from source_revision n where n.organization_id=s.organization_id and n.source_id=s.source_id and n.revision>s.revision) order by s.received_at desc,s.source_id`,
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
    async pendingSources(limit: number): Promise<
      Array<{
        source: SourceEnvelope;
        leaseToken: string;
        generation: number;
        policy: {
          automationPolicy: "review-all" | "validated-auto-record";
          policyVersion: string;
        };
      }>
    > {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid processing limit");
      return db
        .transaction(async (tx) => {
          await tx.execute(
            sql`update processing_work set failed=true,lease_until=null,lease_token=null where attempts=3 and lease_until<=now()`,
          );
          await tx.execute(
            sql`insert into processing_work (organization_id,source_id,source_revision) select s.organization_id,s.source_id,s.revision from source_revision s where not exists (select 1 from source_redaction z where z.organization_id=s.organization_id and z.source_id=s.source_id) and not exists (select 1 from source_revision n where n.organization_id=s.organization_id and n.source_id=s.source_id and n.revision>s.revision) and not exists (select 1 from extraction_run r where r.organization_id=s.organization_id and r.source_id=s.source_id and r.source_revision=s.revision) on conflict do nothing`,
          );
          const rows = await tx.execute(
            sql`with picked as (select w.organization_id,w.source_id,w.source_revision from processing_work w where not exists (select 1 from source_redaction z where z.organization_id=w.organization_id and z.source_id=w.source_id) and w.attempts<3 and (w.lease_until is null or w.lease_until<=now()) and (w.retry_after is null or w.retry_after<=now()) and not exists (select 1 from source_revision n where n.organization_id=w.organization_id and n.source_id=w.source_id and n.revision>w.source_revision) order by w.source_id for update skip locked limit ${limit}), leased as (update processing_work w set attempts=w.attempts+1,lease_token=gen_random_uuid()::text,lease_until=now()+interval '5 minutes',failed=false from picked p where (w.organization_id,w.source_id,w.source_revision)=(p.organization_id,p.source_id,p.source_revision) returning w.*) select s.envelope,w.lease_token,w.generation,p.automation_policy,p.policy_version from leased w join source_revision s on (s.organization_id,s.source_id,s.revision)=(w.organization_id,w.source_id,w.source_revision) join processing_policy_snapshot p on (p.organization_id,p.source_id,p.source_revision,p.generation)=(w.organization_id,w.source_id,w.source_revision,w.generation)`,
          );
          return rows.rows.map((row) => ({
            source: row.envelope as SourceEnvelope,
            leaseToken: row.lease_token as string,
            generation: row.generation as number,
            policy: {
              automationPolicy: row.automation_policy as
                | "review-all"
                | "validated-auto-record",
              policyVersion: row.policy_version as string,
            },
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
      return executeDecision(context, command);
    },
    async retrySource(
      context: TenantContext,
      input: { sourceId: string; idempotencyKey: string },
    ): Promise<Result<void>> {
      if (
        !input ||
        typeof input.sourceId !== "string" ||
        !input.sourceId ||
        typeof input.idempotencyKey !== "string" ||
        !input.idempotencyKey
      )
        return fail(context, "VALIDATION", "Invalid retry command");
      try {
        return await db.transaction(async (tx) => {
          if (!staff(await authorize(tx, context)))
            return fail(context, "FORBIDDEN", "Review authority required");
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${json([context.organizationId, "retry", input.idempotencyKey])},0))`,
          );
          const prior = await tx.execute(
            sql`select source_id from processing_retry where organization_id=${context.organizationId} and idempotency_key=${input.idempotencyKey}`,
          );
          if (prior.rows[0])
            return prior.rows[0].source_id === input.sourceId
              ? success(undefined)
              : fail(context, "CONFLICT", "Idempotency key already used");
          const locked = await tx.execute(
            sql`select id from source where organization_id=${context.organizationId} and id=${input.sourceId} for update`,
          );
          if (!locked.rows.length)
            throw new Abort("NOT_FOUND", "Source not found");
          const redacted = await tx.execute(
            sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${input.sourceId}`,
          );
          if (redacted.rows.length)
            throw new Abort("NOT_FOUND", "Source not found");
          const latest = await tx.execute(
            sql`select revision from source_revision where organization_id=${context.organizationId} and source_id=${input.sourceId} order by revision desc limit 1`,
          );
          const revision = latest.rows[0]?.revision as number | undefined;
          if (!revision) throw new Abort("NOT_FOUND", "Source not found");
          const proposal = await tx.execute(
            sql`select 1 from extraction_run r where organization_id=${context.organizationId} and source_id=${input.sourceId} and source_revision=${revision} and generation=(select max(generation) from processing_policy_snapshot p where p.organization_id=r.organization_id and p.source_id=r.source_id and p.source_revision=r.source_revision)`,
          );
          if (proposal.rows.length)
            throw new Abort("CONFLICT", "Source already has a proposal");
          const work = await tx.execute(
            sql`select attempts,failed,lease_until,lease_until>now() as active from processing_work where organization_id=${context.organizationId} and source_id=${input.sourceId} and source_revision=${revision} for update`,
          );
          const row = work.rows[0];
          if (
            !row ||
            row.active ||
            (!row.failed && (row.attempts as number) < 3)
          )
            throw new Abort("CONFLICT", "Source is not available for retry");
          await tx.execute(
            sql`insert into processing_retry(organization_id,idempotency_key,source_id,source_revision,prior_attempts,actor,correlation_id) values (${context.organizationId},${input.idempotencyKey},${input.sourceId},${revision},${row.attempts as number},${json(context.actor)}::jsonb,${context.correlationId})`,
          );
          await tx.execute(
            sql`update processing_work set attempts=0,failed=false,lease_until=null,lease_token=null,retry_after=null where organization_id=${context.organizationId} and source_id=${input.sourceId} and source_revision=${revision}`,
          );
          return success(undefined);
        });
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
    async reprocessSource(
      context: TenantContext,
      input: {
        sourceId: string;
        expectedRevision: number;
        idempotencyKey: string;
      },
    ): Promise<Result<{ generation: number }>> {
      if (
        !input?.sourceId ||
        !input.idempotencyKey ||
        !Number.isInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      )
        return fail(context, "VALIDATION", "Invalid reprocess command");
      try {
        return await db.transaction(async (tx) => {
          if (!staff(await authorize(tx, context)))
            return fail(context, "FORBIDDEN", "Review authority required");
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${json([context.organizationId, "reprocess", input.idempotencyKey])},0))`,
          );
          const prior = await tx.execute(
            sql`select source_id,source_revision,generation from processing_reprocess where organization_id=${context.organizationId} and idempotency_key=${input.idempotencyKey}`,
          );
          if (prior.rows[0]) {
            const p = prior.rows[0];
            if (
              p.source_id !== input.sourceId ||
              p.source_revision !== input.expectedRevision
            )
              throw new Abort("CONFLICT", "Idempotency key already used");
            return success({ generation: p.generation as number });
          }
          const source = await tx.execute(
            sql`select id from source where organization_id=${context.organizationId} and id=${input.sourceId} for update`,
          );
          if (!source.rows.length)
            throw new Abort("NOT_FOUND", "Source not found");
          const redacted = await tx.execute(
            sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${input.sourceId}`,
          );
          if (redacted.rows.length)
            throw new Abort("NOT_FOUND", "Source not found");
          const latest = await tx.execute(
            sql`select max(revision)::int as revision from source_revision where organization_id=${context.organizationId} and source_id=${input.sourceId}`,
          );
          if (latest.rows[0]?.revision !== input.expectedRevision)
            throw new Abort("CONFLICT", "Source revision changed");
          const work = await tx.execute(
            sql`select lease_until>now() as active from processing_work where organization_id=${context.organizationId} and source_id=${input.sourceId} and source_revision=${input.expectedRevision} for update`,
          );
          if (work.rows[0]?.active)
            throw new Abort("CONFLICT", "Source processing is active");
          await tx.execute(
            sql`select id from organization where id=${context.organizationId} for update`,
          );
          const policy = await tx.execute(
            sql`select automation_policy,policy_version from organization_settings where organization_id=${context.organizationId} for share`,
          );
          const generationRows = await tx.execute(
            sql`select max(generation)::int as generation from processing_policy_snapshot where organization_id=${context.organizationId} and source_id=${input.sourceId} and source_revision=${input.expectedRevision}`,
          );
          const generation =
            ((generationRows.rows[0]?.generation as number | null) ?? 0) + 1;
          const mode =
            (policy.rows[0]?.automation_policy as string | undefined) ??
            "review-all";
          const version =
            (policy.rows[0]?.policy_version as string | undefined) ?? "1";
          await tx.execute(
            sql`insert into processing_policy_snapshot(organization_id,source_id,source_revision,generation,automation_policy,policy_version) values (${context.organizationId},${input.sourceId},${input.expectedRevision},${generation},${mode},${version})`,
          );
          await tx.execute(
            sql`insert into processing_work(organization_id,source_id,source_revision,generation) values (${context.organizationId},${input.sourceId},${input.expectedRevision},${generation}) on conflict(organization_id,source_id,source_revision) do update set generation=excluded.generation,attempts=0,failed=false,lease_token=null,lease_until=null,retry_after=null`,
          );
          await tx.execute(
            sql`insert into processing_reprocess(organization_id,idempotency_key,source_id,source_revision,generation,actor,correlation_id) values (${context.organizationId},${input.idempotencyKey},${input.sourceId},${input.expectedRevision},${generation},${json(context.actor)}::jsonb,${context.correlationId})`,
          );
          return success({ generation });
        });
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
    async applyValidatedPolicy(
      source: SourceEnvelope,
    ): Promise<Result<{ applied: boolean }>> {
      const context: TenantContext = {
        organizationId: source.organizationId,
        actor: { kind: "system", service: "worker" },
        correlationId: `policy:${source.sourceId}`,
      };
      if (!sourceEnvelopeSchema.safeParse(source).success)
        return fail(context, "VALIDATION", "Invalid automatic source");
      try {
        const rows = await db.execute(
          sql`select run_id,proposal from extraction_run r where organization_id=${source.organizationId} and source_id=${source.sourceId} and source_revision=${source.revision} and generation=(select max(p.generation) from processing_policy_snapshot p where p.organization_id=r.organization_id and p.source_id=r.source_id and p.source_revision=r.source_revision)`,
        );
        const row = rows.rows[0];
        if (!row) return success({ applied: false });
        const proposal = row.proposal as ExtractionProposal;
        const command: ReviewDecision = {
          runId: row.run_id as string,
          expectedRevision: 1,
          idempotencyKey: `auto:${createHash("sha256")
            .update(json([source.organizationId, row.run_id]))
            .digest("hex")}`,
          decision: "accept",
          reason: `Automatic policy ${proposal.policyVersion}`,
        };
        const result = await executeDecision(context, command, source);
        if (result.ok) return success({ applied: true });
        if (
          result.error.code === "CONFLICT" ||
          result.error.code === "VALIDATION" ||
          result.error.code === "NOT_FOUND"
        )
          return success({ applied: false });
        return result;
      } catch {
        return fail(
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
      const linkedSources = await tx.execute(
        sql`select count(distinct r.source_id)::int as count from review_effect e join extraction_run r on (r.organization_id,r.run_id)=(e.organization_id,e.run_id) where e.organization_id=${context.organizationId} and e.kind='contribution' and e.aggregate_id=${effect.aggregate_id} and r.status='accepted'`,
      );
      if ((linkedSources.rows[0]?.count as number) > 1)
        throw new Abort(
          "CONFLICT",
          "Shared contribution requires an explicit correction",
        );
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

// An internal, deliberately narrow validated-auto-record gate. Any uncertainty,
// prior source effect or plausible existing record remains in human review.
async function requireValidatedPolicy(
  tx: Executor,
  organizationId: string,
  proposal: ExtractionProposal,
  source: SourceEnvelope,
  generation: number,
): Promise<void> {
  const settings = await tx.execute(
    sql`select automation_policy,policy_version from processing_policy_snapshot where organization_id=${organizationId} and source_id=${source.sourceId} and source_revision=${source.revision} and generation=${generation}`,
  );
  if (
    settings.rows[0]?.automation_policy !== "validated-auto-record" ||
    settings.rows[0]?.policy_version !== proposal.policyVersion
  )
    throw new Abort("CONFLICT", "Automatic policy unavailable");
  if (
    proposal.unresolved.length ||
    proposal.items.length === 0 ||
    !source.author.membershipId
  )
    throw new Abort("CONFLICT", "Proposal requires review");
  const prior = await tx.execute(
    sql`select 1 from extraction_run where organization_id=${organizationId} and source_id=${source.sourceId} and (source_revision<${source.revision} or (source_revision=${source.revision} and generation<${generation})) and status='accepted' limit 1`,
  );
  if (prior.rows.length)
    throw new Abort("CONFLICT", "Prior source effects require review");
  const author = await tx.execute(
    sql`select id from member where organization_id=${organizationId} and id=${source.author.membershipId} for share`,
  );
  if (!author.rows.length)
    throw new Abort("CONFLICT", "Author membership unavailable");
  // The table locks close the race with a simultaneous human ledger/need insert.
  // They are held only through the small acceptance transaction.
  await tx.execute(sql`lock table activity in share row exclusive mode`);
  await tx.execute(sql`lock table need in share row exclusive mode`);
  const activityKeys = new Set(
    proposal.items
      .filter((item) => item.kind === "activity")
      .map((item) => item.key),
  );
  const contributionKeys = new Set(
    proposal.items
      .filter((item) => item.kind === "contribution")
      .map((item) => item.activityKey),
  );
  if ([...activityKeys].some((key) => !contributionKeys.has(key)))
    throw new Abort(
      "CONFLICT",
      "Activity without contribution requires review",
    );
  const seenDates = new Set<string>();
  const seenBeneficiaries = new Set<string>();
  const seenNeedCategories = new Set<string>();
  for (const item of proposal.items) {
    if (item.kind === "activity") {
      if (
        !["visit", "supplies"].includes(item.activityKind) ||
        item.datePrecision !== "day" ||
        !item.localDate
      )
        throw new Abort("CONFLICT", "Activity requires review");
      if (
        seenDates.has(item.localDate) ||
        (item.beneficiaryReference !== null &&
          seenBeneficiaries.has(item.beneficiaryReference))
      )
        throw new Abort("CONFLICT", "Potential activity match requires review");
      seenDates.add(item.localDate);
      if (item.beneficiaryReference !== null)
        seenBeneficiaries.add(item.beneficiaryReference);
      const candidate = await tx.execute(
        sql`select 1 from activity where organization_id=${organizationId} and (local_date=${item.localDate} or (${item.beneficiaryReference}::text is not null and beneficiary_reference=${item.beneficiaryReference})) limit 1`,
      );
      if (candidate.rows.length)
        throw new Abort("CONFLICT", "Potential activity match requires review");
    } else if (item.kind === "contribution") {
      if (
        !item.membershipId ||
        !item.durationMinutes ||
        item.durationMinutes > 1440 ||
        !activityKeys.has(item.activityKey)
      )
        throw new Abort("CONFLICT", "Contribution requires review");
      const member = await tx.execute(
        sql`select id from member where organization_id=${organizationId} and id=${item.membershipId} for share`,
      );
      if (!member.rows.length)
        throw new Abort("CONFLICT", "Contribution membership unavailable");
    } else if (item.kind === "need") {
      if (
        !["food", "supplies"].includes(item.category) ||
        item.urgency !== "routine" ||
        item.provisional
      )
        throw new Abort("CONFLICT", "Need requires review");
      if (seenNeedCategories.has(item.category))
        throw new Abort("CONFLICT", "Potential need match requires review");
      seenNeedCategories.add(item.category);
      const candidate = await tx.execute(
        sql`select 1 from need where organization_id=${organizationId} and category=${item.category} and status in ('new','assigned','acknowledged') limit 1`,
      );
      if (candidate.rows.length)
        throw new Abort("CONFLICT", "Potential need match requires review");
    } else throw new Abort("CONFLICT", "Correction requires review");
  }
}

const itemKeyHash = (key: string) =>
  createHash("sha256").update(key).digest("hex");
type ProposedNeed = Extract<
  ExtractionProposal["items"][number],
  { kind: "need" }
>;
async function createProvisionalNeeds(
  tx: Executor,
  context: TenantContext,
  source: SourceEnvelope,
  proposal: ExtractionProposal,
  generation: number,
): Promise<void> {
  for (const item of proposal.items) {
    if (item.kind !== "need" || item.urgency !== "urgent") continue;
    const prior = await tx.execute(
      sql`select 1 from review_effect e join extraction_run r on (r.organization_id,r.run_id)=(e.organization_id,e.run_id) where r.organization_id=${context.organizationId} and r.source_id=${source.sourceId} and (r.source_revision<${source.revision} or (r.source_revision=${source.revision} and r.generation<${generation})) and r.status='accepted' and e.kind='need' and e.item_key=${item.key} limit 1`,
    );
    if (prior.rows.length) continue;
    const now = new Date();
    const id = randomUUID();
    const timestamp = now.toISOString();
    const origin = {
      kind: "source",
      sourceId: source.sourceId,
      sourceRevision: source.revision,
    };
    const record = {
      schemaVersion: 1,
      organizationId: context.organizationId,
      needId: id,
      revision: 1,
      category: item.category,
      urgency: item.urgency,
      summary: item.summary,
      provisional: true,
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
      sql`insert into need (organization_id,id,revision,category,urgency,summary,provisional,status,origin_kind,origin_source_id,origin_source_revision,created_at,updated_at) values (${context.organizationId},${id},1,${item.category},${item.urgency},${item.summary},true,'new','source',${source.sourceId},${source.revision},${now},${now})`,
    );
    await audit(
      tx,
      context,
      "need",
      id,
      record,
      now,
      "Provisional urgent extraction",
    );
    await event(
      tx,
      context,
      "need.changed",
      id,
      { needId: id, status: "new", provisional: true },
      now,
    );
    await tx.execute(
      sql`insert into provisional_need(organization_id,run_id,item_key_hash,need_id) values (${context.organizationId},${proposal.runId},${itemKeyHash(item.key)},${id})`,
    );
  }
}
async function updateProvisional(
  tx: Executor,
  context: TenantContext,
  id: string,
  action: "confirm" | "withdraw",
  item: ProposedNeed | null,
  reason: string,
): Promise<number> {
  const rows = await tx.execute(
    sql`select n.*,a.after from need n left join domain_audit_event a on a.organization_id=n.organization_id and a.aggregate_type='need' and a.aggregate_id=n.id and a.aggregate_revision=n.revision where n.organization_id=${context.organizationId} and n.id=${id} for update of n`,
  );
  const row = rows.rows[0];
  if (!row) throw new Abort("CONFLICT", "Provisional need unavailable");
  if (
    action === "withdraw" &&
    (row.status === "cancelled" || row.status === "resolved")
  )
    return row.revision as number;
  if (action === "confirm" && row.status === "cancelled")
    throw new Abort("CONFLICT", "Provisional need was cancelled");
  if (!row.provisional)
    throw new Abort("CONFLICT", "Provisional need already changed");
  const before = row.after as Record<string, unknown> | undefined;
  if (!before)
    throw new Abort("CONFLICT", "Provisional need history unavailable");
  const revision = (row.revision as number) + 1;
  const now = new Date();
  const status = action === "withdraw" ? "cancelled" : (row.status as string);
  const provisional =
    action === "withdraw" ? true : (item?.provisional ?? true);
  const after = {
    ...before,
    revision,
    status,
    provisional,
    category: item?.category ?? row.category,
    urgency: item?.urgency ?? row.urgency,
    summary: item?.summary ?? row.summary,
    updatedAt: now.toISOString(),
  };
  await tx.execute(
    sql`update need set revision=${revision},status=${status},provisional=${provisional},category=${item?.category ?? (row.category as string)},urgency=${item?.urgency ?? (row.urgency as string)},summary=${item?.summary ?? (row.summary as string)},updated_at=${now} where organization_id=${context.organizationId} and id=${id}`,
  );
  await tx.execute(
    sql`insert into domain_audit_event(organization_id,id,aggregate_type,aggregate_id,aggregate_revision,action,actor,correlation_id,reason,before,after,occurred_at) values (${context.organizationId},${`need:${id}:${revision}`},'need',${id},${revision},${action === "confirm" ? "confirmed" : "withdrawn"},${json(context.actor)}::jsonb,${context.correlationId},${reason || null},${json(before)}::jsonb,${json(after)}::jsonb,${now})`,
  );
  await event(
    tx,
    context,
    "need.changed",
    id,
    { needId: id, status, provisional },
    now,
    revision,
  );
  return revision;
}
async function withdrawRemainingProvisional(
  tx: Executor,
  context: TenantContext,
  runId: string,
  keep: string[],
  reason: string,
): Promise<void> {
  const rows = await tx.execute(
    sql`select item_key_hash,need_id from provisional_need where organization_id=${context.organizationId} and run_id=${runId}`,
  );
  for (const row of rows.rows)
    if (!keep.includes(row.item_key_hash as string))
      await updateProvisional(
        tx,
        context,
        row.need_id as string,
        "withdraw",
        null,
        reason,
      );
}
async function withdrawEarlierProvisional(
  tx: Executor,
  context: TenantContext,
  proposal: ExtractionProposal,
  generation: number,
): Promise<void> {
  const rows = await tx.execute(
    sql`select p.need_id from provisional_need p join extraction_run r on (r.organization_id,r.run_id)=(p.organization_id,p.run_id) where r.organization_id=${context.organizationId} and r.source_id=${proposal.sourceId} and (r.source_revision<${proposal.sourceRevision} or (r.source_revision=${proposal.sourceRevision} and r.generation<${generation})) and r.status='review'`,
  );
  for (const row of rows.rows)
    await updateProvisional(
      tx,
      context,
      row.need_id as string,
      "withdraw",
      null,
      "Superseded source revision",
    );
}
