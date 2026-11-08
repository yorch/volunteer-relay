import type { TenantContext } from "@relay/contracts";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
import { sourceAuthor, sourceRevision } from "./core.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// Every domain record carries a provenance: either an immutable source
// revision in the same tenant, or a staff-recorded reason. The CHECK and the
// composite FK together keep a source origin inside its own tenant.
const originColumns = {
  originKind: text("origin_kind").notNull(),
  originSourceId: text("origin_source_id"),
  originSourceRevision: integer("origin_source_revision"),
  originReason: text("origin_reason"),
};

const originConsistencyCheck = (table: {
  originKind: AnyPgColumn;
  originSourceId: AnyPgColumn;
  originSourceRevision: AnyPgColumn;
  originReason: AnyPgColumn;
}) => sql`(
    (${table.originKind} = 'source'
      and ${table.originSourceId} is not null
      and ${table.originSourceRevision} is not null
      and ${table.originReason} is null)
    or (${table.originKind} = 'staff'
      and ${table.originReason} is not null
      and ${table.originSourceId} is null
      and ${table.originSourceRevision} is null)
  )`;

const originSourceFk = (
  name: string,
  table: {
    organizationId: AnyPgColumn;
    originSourceId: AnyPgColumn;
    originSourceRevision: AnyPgColumn;
  },
) =>
  foreignKey({
    name,
    columns: [
      table.organizationId,
      table.originSourceId,
      table.originSourceRevision,
    ],
    foreignColumns: [
      sourceRevision.organizationId,
      sourceRevision.sourceId,
      sourceRevision.revision,
    ],
  });

// Approved contribution minutes are the reporting ledger (ADR 0009). A
// membership holds at most one active (pending or approved) contribution per
// activity; the partial unique index is the concurrency boundary.
export const activity = pgTable(
  "activity",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    kind: text("kind").notNull(),
    localDate: date("local_date", { mode: "string" }),
    datePrecision: text("date_precision").notNull(),
    beneficiaryReference: text("beneficiary_reference"),
    ...originColumns,
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check("activity_revision_check", sql`${table.revision} >= 1`),
    check(
      "activity_date_precision_check",
      sql`${table.datePrecision} in ('day', 'unknown') and (${table.datePrecision} = 'day') = (${table.localDate} is not null)`,
    ),
    check("activity_origin_check", originConsistencyCheck(table)),
    originSourceFk("activity_origin_source_fk", table),
  ],
);

export const contribution = pgTable(
  "contribution",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    activityId: text("activity_id").notNull(),
    // Historical membership reference anchored in source_author, so later
    // membership removal keeps the ledger row and its minutes.
    membershipId: text("membership_id"),
    // Integer minutes 1..1440; unknown is null, never zero.
    durationMinutes: integer("duration_minutes"),
    status: text("status").notNull(),
    ...originColumns,
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check("contribution_revision_check", sql`${table.revision} >= 1`),
    check(
      "contribution_status_check",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'superseded')`,
    ),
    check(
      "contribution_duration_check",
      sql`${table.durationMinutes} is null or (${table.durationMinutes} >= 1 and ${table.durationMinutes} <= 1440)`,
    ),
    // The same approved invariant the contract schema enforces.
    check(
      "contribution_approved_check",
      sql`${table.status} <> 'approved' or (${table.membershipId} is not null and ${table.durationMinutes} is not null)`,
    ),
    check("contribution_origin_check", originConsistencyCheck(table)),
    uniqueIndex("contribution_active_membership_unique")
      .on(table.organizationId, table.activityId, table.membershipId)
      .where(
        sql`${table.membershipId} is not null and ${table.status} in ('pending', 'approved')`,
      ),
    foreignKey({
      name: "contribution_activity_fk",
      columns: [table.organizationId, table.activityId],
      foreignColumns: [activity.organizationId, activity.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "contribution_membership_fk",
      columns: [table.organizationId, table.membershipId],
      foreignColumns: [sourceAuthor.organizationId, sourceAuthor.membershipId],
    }),
    originSourceFk("contribution_origin_source_fk", table),
  ],
);

// Need status and its field consistency mirror needRecordSchema exactly:
// new has no owner/acknowledgment/resolution; assigned has an owner only;
// acknowledged has both owner and acknowledgment; resolved always carries a
// resolution; cancelled keeps whatever acknowledgment it had.
export const need = pgTable(
  "need",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    category: text("category").notNull(),
    urgency: text("urgency").notNull(),
    summary: text("summary").notNull(),
    provisional: boolean("provisional").notNull(),
    status: text("status").notNull(),
    ownerMembershipId: text("owner_membership_id"),
    acknowledgedByMembershipId: text("acknowledged_by_membership_id"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    acknowledgeBy: timestamp("acknowledge_by", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    ...originColumns,
    createdAt,
    updatedAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check("need_revision_check", sql`${table.revision} >= 1`),
    check("need_urgency_check", sql`${table.urgency} in ('routine', 'urgent')`),
    check(
      "need_status_check",
      sql`${table.status} in ('new', 'assigned', 'acknowledged', 'resolved', 'cancelled')`,
    ),
    check(
      "need_status_fields_check",
      sql`(
        (${table.status} = 'new'
          and ${table.ownerMembershipId} is null
          and ${table.acknowledgedAt} is null
          and ${table.acknowledgedByMembershipId} is null
          and ${table.resolvedAt} is null
          and ${table.resolution} is null)
        or (${table.status} = 'assigned'
          and ${table.ownerMembershipId} is not null
          and ${table.acknowledgedAt} is null
          and ${table.acknowledgedByMembershipId} is null
          and ${table.resolvedAt} is null
          and ${table.resolution} is null)
        or (${table.status} = 'acknowledged'
          and ${table.ownerMembershipId} is not null
          and ${table.acknowledgedAt} is not null
          and ${table.acknowledgedByMembershipId} is not null
          and ${table.resolvedAt} is null
          and ${table.resolution} is null)
        or (${table.status} = 'resolved'
          and ${table.resolvedAt} is not null
          and ${table.resolution} is not null
          and ((${table.acknowledgedAt} is not null and ${table.acknowledgedByMembershipId} is not null)
            or (${table.acknowledgedAt} is null and ${table.acknowledgedByMembershipId} is null)))
        or (${table.status} = 'cancelled'
          and ${table.resolvedAt} is null
          and ${table.resolution} is null
          and ((${table.acknowledgedAt} is not null and ${table.acknowledgedByMembershipId} is not null)
            or (${table.acknowledgedAt} is null and ${table.acknowledgedByMembershipId} is null)))
      )`,
    ),
    check("need_origin_check", originConsistencyCheck(table)),
    foreignKey({
      name: "need_owner_fk",
      columns: [table.organizationId, table.ownerMembershipId],
      foreignColumns: [sourceAuthor.organizationId, sourceAuthor.membershipId],
    }),
    foreignKey({
      name: "need_acknowledger_fk",
      columns: [table.organizationId, table.acknowledgedByMembershipId],
      foreignColumns: [sourceAuthor.organizationId, sourceAuthor.membershipId],
    }),
    originSourceFk("need_origin_source_fk", table),
  ],
);

// One immutable row per aggregate revision; this is the retained history that
// preserves prior contribution states. UPDATE is rejected by trigger.
export const domainAuditEvent = pgTable(
  "domain_audit_event",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateRevision: integer("aggregate_revision").notNull(),
    action: text("action").notNull(),
    actor: jsonb("actor").$type<TenantContext["actor"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check(
      "domain_audit_event_aggregate_type_check",
      sql`${table.aggregateType} in ('activity', 'contribution', 'need')`,
    ),
    uniqueIndex("domain_audit_event_revision_unique").on(
      table.organizationId,
      table.aggregateType,
      table.aggregateId,
      table.aggregateRevision,
    ),
  ],
);

// Idempotent command log: the stored result is returned verbatim on replay,
// so a retried mutation never takes effect twice. Immutable by trigger.
export const domainCommand = pgTable(
  "domain_command",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    commandDigest: text("command_digest").notNull(),
    result: jsonb("result").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.idempotencyKey] }),
  ],
);
