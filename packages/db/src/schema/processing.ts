import type {
  ExtractionProposal,
  ReviewDecision,
  ReviewOutcome,
  TenantContext,
} from "@relay/contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sourceRevision } from "./core.ts";

export const processingWork = pgTable(
  "processing_work",
  {
    organizationId: text("organization_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    retryAfter: timestamp("retry_after", { withTimezone: true }),
    failed: boolean("failed").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.sourceId, t.sourceRevision] }),
    check("processing_work_attempts_check", sql`${t.attempts} between 0 and 3`),
    foreignKey({
      columns: [t.organizationId, t.sourceId, t.sourceRevision],
      foreignColumns: [
        sourceRevision.organizationId,
        sourceRevision.sourceId,
        sourceRevision.revision,
      ],
    }),
  ],
);
export const extractionRun = pgTable(
  "extraction_run",
  {
    organizationId: text("organization_id").notNull(),
    runId: text("run_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    proposal: jsonb("proposal").$type<ExtractionProposal>().notNull(),
    status: text("status").notNull().default("review"),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.runId] }),
    unique().on(t.organizationId, t.sourceId, t.sourceRevision),
    check(
      "extraction_run_status_check",
      sql`${t.status} in ('review','accepted','rejected')`,
    ),
    check("extraction_run_revision_check", sql`${t.revision} > 0`),
    foreignKey({
      columns: [t.organizationId, t.sourceId, t.sourceRevision],
      foreignColumns: [
        sourceRevision.organizationId,
        sourceRevision.sourceId,
        sourceRevision.revision,
      ],
    }),
  ],
);
export const reviewDecision = pgTable(
  "review_decision",
  {
    organizationId: text("organization_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    runId: text("run_id").notNull(),
    command: jsonb("command").$type<ReviewDecision>().notNull(),
    outcome: jsonb("outcome").$type<ReviewOutcome>().notNull(),
    actor: jsonb("actor").$type<TenantContext["actor"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.idempotencyKey] }),
    unique().on(t.organizationId, t.runId),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [extractionRun.organizationId, extractionRun.runId],
    }),
  ],
);

// Each accepted run records which item affected which aggregate and the exact
// resulting revision. This is the optimistic reconciliation boundary.
export const reviewEffect = pgTable(
  "review_effect",
  {
    organizationId: text("organization_id").notNull(),
    runId: text("run_id").notNull(),
    itemKey: text("item_key").notNull(),
    kind: text("kind").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateRevision: integer("aggregate_revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.runId, t.itemKey] }),
    check(
      "review_effect_kind_check",
      sql`${t.kind} in ('activity','contribution','need')`,
    ),
    check("review_effect_revision_check", sql`${t.aggregateRevision} > 0`),
    foreignKey({
      columns: [t.organizationId, t.runId],
      foreignColumns: [extractionRun.organizationId, extractionRun.runId],
    }),
  ],
);
// Immutable staff-authorized retry history; no source text is copied here.
export const processingRetry = pgTable(
  "processing_retry",
  {
    organizationId: text("organization_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    priorAttempts: integer("prior_attempts").notNull(),
    actor: jsonb("actor").$type<TenantContext["actor"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.idempotencyKey] }),
    foreignKey({
      columns: [t.organizationId, t.sourceId, t.sourceRevision],
      foreignColumns: [
        sourceRevision.organizationId,
        sourceRevision.sourceId,
        sourceRevision.revision,
      ],
    }),
  ],
);
