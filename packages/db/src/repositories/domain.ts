import type {
  ActivityRecord,
  ContributionRecord,
  LedgerSummary,
  NeedRecord,
  RecordOrigin,
  TenantContext,
} from "@relay/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  activity,
  contribution,
  domainAuditEvent,
  domainCommand,
  member,
  need,
  outboxEvent,
  sourceAuthor,
} from "../schema/index.ts";
import type { Database } from "../types.ts";

// Structural mirror of the DomainStore port declared in packages/domain/core.
// The db package does not depend on the domain package; the composition point
// type-checks this implementation against the port.

export interface DomainAuditEntry {
  aggregateType: "activity" | "contribution" | "need";
  aggregateId: string;
  aggregateRevision: number;
  action: string;
  actor: TenantContext["actor"];
  correlationId: string;
  reason: string | null;
  before: unknown | null;
  after: unknown;
  occurredAt: Date;
}

export interface DomainOutboxEntry {
  id: string;
  type: "ledger.changed" | "need.changed";
  aggregateId: string;
  aggregateRevision: number;
  payload: unknown;
  actor: TenantContext["actor"];
  correlationId: string;
  occurredAt: Date;
}

export type DomainWrite =
  | { kind: "insert-activity"; record: ActivityRecord }
  | {
      kind: "update-activity";
      record: ActivityRecord;
      expectedRevision: number;
    }
  | { kind: "insert-contribution"; record: ContributionRecord }
  | {
      kind: "update-contribution";
      record: ContributionRecord;
      expectedRevision: number;
      expectedStatus: ContributionRecord["status"];
    }
  | { kind: "insert-need"; record: NeedRecord }
  | {
      kind: "update-need";
      record: NeedRecord;
      expectedRevision: number;
      expectedStatus: NeedRecord["status"];
    };

export interface DomainMutationRecord {
  organizationId: string;
  command: {
    idempotencyKey: string;
    commandType: string;
    digest: string;
    result: unknown;
    correlationId: string;
  };
  anchors: string[];
  writes: DomainWrite[];
  audit: DomainAuditEntry[];
  events: DomainOutboxEntry[];
}

export interface StoredDomainCommand {
  commandType: string;
  digest: string;
  result: unknown;
}

export type DomainCommitOutcome =
  | { kind: "committed" }
  | { kind: "replay"; command: StoredDomainCommand }
  | {
      kind: "conflict";
      reason: "revision" | "duplicate-contribution" | "idempotency";
    }
  | { kind: "invalid-target"; field: "membership" | "origin" | "activity" };

export interface DomainStoreRecord {
  findCommand(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<StoredDomainCommand | null>;
  findMembershipRole(
    organizationId: string,
    membershipId: string,
  ): Promise<string | null>;
  getActivity(
    organizationId: string,
    activityId: string,
  ): Promise<ActivityRecord | null>;
  getContribution(
    organizationId: string,
    contributionId: string,
  ): Promise<ContributionRecord | null>;
  listActivityContributions(
    organizationId: string,
    activityId: string,
  ): Promise<ContributionRecord[]>;
  listContributions(
    organizationId: string,
    query: {
      status?: ContributionRecord["status"];
      membershipId?: string;
      limit: number;
    },
  ): Promise<ContributionRecord[]>;
  summarize(organizationId: string): Promise<LedgerSummary>;
  getNeed(organizationId: string, needId: string): Promise<NeedRecord | null>;
  listNeeds(
    organizationId: string,
    query: { status?: NeedRecord["status"]; limit: number },
  ): Promise<NeedRecord[]>;
  commit(mutation: DomainMutationRecord): Promise<DomainCommitOutcome>;
}

type ActivityRow = typeof activity.$inferSelect;
type ContributionRow = typeof contribution.$inferSelect;
type NeedRow = typeof need.$inferSelect;

function pgErrorField(
  error: unknown,
  field: "code" | "constraint",
): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// Thrown to abort the transaction when the outcome is decided before or during
// the write, so an early conflict leaves nothing behind.
class OutcomeRollback extends Error {
  readonly outcome: DomainCommitOutcome;
  constructor(outcome: DomainCommitOutcome) {
    super("transaction rolled back to report an outcome");
    this.name = "OutcomeRollback";
    this.outcome = outcome;
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

function toInstant(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function toOrigin(row: {
  originKind: string;
  originSourceId: string | null;
  originSourceRevision: number | null;
  originReason: string | null;
}): RecordOrigin {
  if (row.originKind === "source")
    return {
      kind: "source",
      sourceId: row.originSourceId ?? "",
      sourceRevision: row.originSourceRevision ?? 0,
    };
  return { kind: "staff", reason: row.originReason ?? "" };
}

function originColumns(origin: RecordOrigin) {
  return origin.kind === "source"
    ? {
        originKind: "source",
        originSourceId: origin.sourceId,
        originSourceRevision: origin.sourceRevision,
        originReason: null,
      }
    : {
        originKind: "staff",
        originSourceId: null,
        originSourceRevision: null,
        originReason: origin.reason,
      };
}

function toActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    schemaVersion: 1,
    organizationId: row.organizationId,
    activityId: row.id,
    revision: row.revision,
    kind: row.kind,
    localDate: row.localDate,
    datePrecision: row.datePrecision as ActivityRecord["datePrecision"],
    beneficiaryReference: row.beneficiaryReference,
    origin: toOrigin(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toContributionRecord(row: ContributionRow): ContributionRecord {
  return {
    schemaVersion: 1,
    organizationId: row.organizationId,
    contributionId: row.id,
    activityId: row.activityId,
    revision: row.revision,
    membershipId: row.membershipId,
    durationMinutes: row.durationMinutes,
    status: row.status as ContributionRecord["status"],
    origin: toOrigin(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toNeedRecord(row: NeedRow): NeedRecord {
  return {
    schemaVersion: 1,
    organizationId: row.organizationId,
    needId: row.id,
    revision: row.revision,
    category: row.category,
    urgency: row.urgency as NeedRecord["urgency"],
    summary: row.summary,
    provisional: row.provisional,
    status: row.status as NeedRecord["status"],
    ownerMembershipId: row.ownerMembershipId,
    dueAt: toInstant(row.dueAt),
    acknowledgeBy: toInstant(row.acknowledgeBy),
    acknowledgedAt: toInstant(row.acknowledgedAt),
    acknowledgedByMembershipId: row.acknowledgedByMembershipId,
    resolvedAt: toInstant(row.resolvedAt),
    resolution: row.resolution,
    origin: toOrigin(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function activityValues(record: ActivityRecord) {
  return {
    organizationId: record.organizationId,
    id: record.activityId,
    revision: record.revision,
    kind: record.kind,
    localDate: record.localDate,
    datePrecision: record.datePrecision,
    beneficiaryReference: record.beneficiaryReference,
    ...originColumns(record.origin),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function contributionValues(record: ContributionRecord) {
  return {
    organizationId: record.organizationId,
    id: record.contributionId,
    revision: record.revision,
    activityId: record.activityId,
    membershipId: record.membershipId,
    durationMinutes: record.durationMinutes,
    status: record.status,
    ...originColumns(record.origin),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

function needValues(record: NeedRecord) {
  return {
    organizationId: record.organizationId,
    id: record.needId,
    revision: record.revision,
    category: record.category,
    urgency: record.urgency,
    summary: record.summary,
    provisional: record.provisional,
    status: record.status,
    ownerMembershipId: record.ownerMembershipId,
    acknowledgedByMembershipId: record.acknowledgedByMembershipId,
    dueAt: record.dueAt === null ? null : new Date(record.dueAt),
    acknowledgeBy:
      record.acknowledgeBy === null ? null : new Date(record.acknowledgeBy),
    acknowledgedAt:
      record.acknowledgedAt === null ? null : new Date(record.acknowledgedAt),
    resolvedAt: record.resolvedAt === null ? null : new Date(record.resolvedAt),
    resolution: record.resolution,
    ...originColumns(record.origin),
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}

const membershipExists = (organizationId: string, membershipId: string) =>
  sql`select 1 from ${member} where organization_id = ${organizationId} and id = ${membershipId}`;

// The tenant-scoped historical anchor is upserted when a live membership is
// first referenced; revocation later clears only the nullable live pointer.
async function ensureAuthorAnchor(
  tx: Tx,
  organizationId: string,
  membershipId: string,
): Promise<void> {
  const rows = await tx.execute(membershipExists(organizationId, membershipId));
  if (rows.rows.length === 0)
    throw new OutcomeRollback({ kind: "invalid-target", field: "membership" });
  await tx
    .insert(sourceAuthor)
    .values({ organizationId, membershipId, currentMembershipId: membershipId })
    .onConflictDoUpdate({
      target: [sourceAuthor.organizationId, sourceAuthor.membershipId],
      set: { currentMembershipId: membershipId },
    });
}

async function applyWrite(
  tx: Tx,
  mutation: DomainMutationRecord,
  write: DomainWrite,
): Promise<void> {
  const organizationId = mutation.organizationId;
  switch (write.kind) {
    case "insert-activity":
      await tx.insert(activity).values(activityValues(write.record));
      return;
    case "update-activity": {
      const values = activityValues(write.record);
      const updated = await tx
        .update(activity)
        .set(values)
        .where(
          and(
            eq(activity.organizationId, organizationId),
            eq(activity.id, write.record.activityId),
            eq(activity.revision, write.expectedRevision),
          ),
        )
        .returning({ id: activity.id });
      if (updated.length === 0)
        throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
      return;
    }
    case "insert-contribution":
      await tx.insert(contribution).values(contributionValues(write.record));
      return;
    case "update-contribution": {
      const values = contributionValues(write.record);
      const updated = await tx
        .update(contribution)
        .set(values)
        .where(
          and(
            eq(contribution.organizationId, organizationId),
            eq(contribution.id, write.record.contributionId),
            eq(contribution.revision, write.expectedRevision),
            eq(contribution.status, write.expectedStatus),
          ),
        )
        .returning({ id: contribution.id });
      if (updated.length === 0)
        throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
      return;
    }
    case "insert-need":
      await tx.insert(need).values(needValues(write.record));
      return;
    case "update-need": {
      const values = needValues(write.record);
      const updated = await tx
        .update(need)
        .set(values)
        .where(
          and(
            eq(need.organizationId, organizationId),
            eq(need.id, write.record.needId),
            eq(need.revision, write.expectedRevision),
            eq(need.status, write.expectedStatus),
          ),
        )
        .returning({ id: need.id });
      if (updated.length === 0)
        throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
      return;
    }
  }
}

export function createDomainStore(db: Database): DomainStoreRecord {
  async function findCommand(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<StoredDomainCommand | null> {
    const rows = await db
      .select({
        commandType: domainCommand.commandType,
        digest: domainCommand.commandDigest,
        result: domainCommand.result,
      })
      .from(domainCommand)
      .where(
        and(
          eq(domainCommand.organizationId, organizationId),
          eq(domainCommand.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      commandType: row.commandType,
      digest: row.digest,
      result: row.result,
    };
  }

  // After a unique-violation rollback, classify the outcome from the winner.
  async function classifyUniqueViolation(
    mutation: DomainMutationRecord,
    constraint: string,
  ): Promise<DomainCommitOutcome> {
    if (constraint.startsWith("domain_command")) {
      const stored = await findCommand(
        mutation.organizationId,
        mutation.command.idempotencyKey,
      );
      if (stored && stored.digest === mutation.command.digest)
        return { kind: "replay", command: stored };
      return { kind: "conflict", reason: "idempotency" };
    }
    if (constraint.startsWith("contribution_active"))
      return { kind: "conflict", reason: "duplicate-contribution" };
    return { kind: "conflict", reason: "revision" };
  }

  return {
    findCommand,

    async findMembershipRole(organizationId, membershipId) {
      const rows = await db
        .select({ role: member.role })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.id, membershipId),
          ),
        )
        .limit(1);
      return rows[0]?.role ?? null;
    },

    async getActivity(organizationId, activityId) {
      const rows = await db
        .select()
        .from(activity)
        .where(
          and(
            eq(activity.organizationId, organizationId),
            eq(activity.id, activityId),
          ),
        )
        .limit(1);
      return rows[0] ? toActivityRecord(rows[0]) : null;
    },

    async getContribution(organizationId, contributionId) {
      const rows = await db
        .select()
        .from(contribution)
        .where(
          and(
            eq(contribution.organizationId, organizationId),
            eq(contribution.id, contributionId),
          ),
        )
        .limit(1);
      return rows[0] ? toContributionRecord(rows[0]) : null;
    },

    async listActivityContributions(organizationId, activityId) {
      const rows = await db
        .select()
        .from(contribution)
        .where(
          and(
            eq(contribution.organizationId, organizationId),
            eq(contribution.activityId, activityId),
          ),
        )
        .orderBy(contribution.createdAt, contribution.id);
      return rows.map(toContributionRecord);
    },

    async listContributions(organizationId, query) {
      const conditions = [eq(contribution.organizationId, organizationId)];
      if (query.status !== undefined)
        conditions.push(eq(contribution.status, query.status));
      if (query.membershipId !== undefined)
        conditions.push(eq(contribution.membershipId, query.membershipId));
      const rows = await db
        .select()
        .from(contribution)
        .where(and(...conditions))
        .orderBy(desc(contribution.createdAt), contribution.id)
        .limit(query.limit);
      return rows.map(toContributionRecord);
    },

    async summarize(organizationId) {
      const result = await db.execute(sql`
        select
          coalesce(sum(${contribution.durationMinutes}) filter (where ${contribution.status} = 'approved'), 0)::int as approved_minutes,
          count(*) filter (where ${contribution.status} = 'approved')::int as approved_contributions,
          count(distinct ${contribution.activityId}) filter (where ${contribution.status} = 'approved')::int as activities_with_approved,
          count(*) filter (where ${contribution.status} = 'pending')::int as pending_contributions,
          count(*) filter (where ${contribution.status} = 'pending' and ${contribution.durationMinutes} is null)::int as pending_unknown_duration,
          count(*) filter (where ${contribution.status} = 'pending' and ${contribution.membershipId} is null)::int as pending_unresolved_volunteer
        from ${contribution}
        where ${contribution.organizationId} = ${organizationId}
      `);
      const row = (result.rows[0] ?? {}) as Record<string, number | undefined>;
      return {
        approvedMinutes: row.approved_minutes ?? 0,
        approvedContributions: row.approved_contributions ?? 0,
        activitiesWithApprovedContributions: row.activities_with_approved ?? 0,
        pendingContributions: row.pending_contributions ?? 0,
        pendingUnknownDuration: row.pending_unknown_duration ?? 0,
        pendingUnresolvedVolunteer: row.pending_unresolved_volunteer ?? 0,
      };
    },

    async getNeed(organizationId, needId) {
      const rows = await db
        .select()
        .from(need)
        .where(
          and(eq(need.organizationId, organizationId), eq(need.id, needId)),
        )
        .limit(1);
      return rows[0] ? toNeedRecord(rows[0]) : null;
    },

    async listNeeds(organizationId, query) {
      const conditions = [eq(need.organizationId, organizationId)];
      if (query.status !== undefined)
        conditions.push(eq(need.status, query.status));
      const rows = await db
        .select()
        .from(need)
        .where(and(...conditions))
        .orderBy(desc(need.createdAt), need.id)
        .limit(query.limit);
      return rows.map(toNeedRecord);
    },

    async commit(mutation) {
      try {
        return await db.transaction(async (tx) => {
          // The command row goes first: a concurrent mutation with the same
          // idempotency key blocks on the primary key until this transaction
          // resolves, then classifies as replay or idempotency conflict from
          // the winning row.
          await tx.insert(domainCommand).values({
            organizationId: mutation.organizationId,
            idempotencyKey: mutation.command.idempotencyKey,
            commandType: mutation.command.commandType,
            commandDigest: mutation.command.digest,
            result: mutation.command.result,
            correlationId: mutation.command.correlationId,
          });
          // Anchors are verified against live member rows, then upserted into
          // the historical source_author anchor exactly like source intake.
          for (const membershipId of new Set(mutation.anchors))
            await ensureAuthorAnchor(tx, mutation.organizationId, membershipId);
          for (const write of mutation.writes)
            await applyWrite(tx, mutation, write);
          for (const entry of mutation.audit)
            await tx.insert(domainAuditEvent).values({
              organizationId: mutation.organizationId,
              id: `${entry.aggregateType}:${entry.aggregateId}:${entry.aggregateRevision}`,
              aggregateType: entry.aggregateType,
              aggregateId: entry.aggregateId,
              aggregateRevision: entry.aggregateRevision,
              action: entry.action,
              actor: entry.actor,
              correlationId: entry.correlationId,
              reason: entry.reason,
              before: entry.before,
              after: entry.after,
              occurredAt: entry.occurredAt,
            });
          for (const event of mutation.events)
            await tx.insert(outboxEvent).values({
              id: event.id,
              organizationId: mutation.organizationId,
              type: event.type,
              aggregateId: event.aggregateId,
              aggregateRevision: event.aggregateRevision,
              payload: event.payload,
              actor: event.actor,
              correlationId: event.correlationId,
              occurredAt: event.occurredAt,
            });
          return { kind: "committed" } as DomainCommitOutcome;
        });
      } catch (error) {
        if (error instanceof OutcomeRollback) return error.outcome;
        const code = pgErrorField(error, "code");
        const constraint = pgErrorField(error, "constraint") ?? "";
        if (code === "23505")
          return classifyUniqueViolation(mutation, constraint);
        if (code === "23503") {
          if (constraint.includes("origin"))
            return { kind: "invalid-target", field: "origin" };
          if (constraint.includes("activity"))
            return { kind: "invalid-target", field: "activity" };
          if (
            constraint.includes("membership") ||
            constraint.includes("owner") ||
            constraint.includes("acknowledger")
          )
            return { kind: "invalid-target", field: "membership" };
        }
        if (code === "40001") return { kind: "conflict", reason: "revision" };
        // Unexpected storage failure: a fixed message with no driver cause, so
        // no record text or PostgreSQL detail can reach the caller.
        throw new Error("domain storage failure");
      }
    },
  };
}
