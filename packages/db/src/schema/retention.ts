import type { TenantContext } from "@relay/contracts";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";

const time = (name: string) => timestamp(name, { withTimezone: true });
export const sourceRedaction = pgTable(
  "source_redaction",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    sourceId: text("source_id").notNull(),
    redactionId: text("redaction_id").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    reason: text("reason").notNull(),
    reasonHash: text("reason_hash").notNull(),
    sourceDigest: text("source_digest").notNull(),
    actor: jsonb("actor").$type<TenantContext["actor"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    redactedAt: time("redacted_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.sourceId] }),
    unique().on(t.organizationId, t.idempotencyKey),
    unique().on(t.redactionId),
  ],
);
export const blobErasureJob = pgTable("blob_erasure_job", {
  storageKey: text("storage_key").primaryKey(),
  sha256: text("sha256").notNull(),
  completed: boolean("completed").notNull().default(false),
  attempts: integer("attempts").notNull().default(0),
  leaseToken: text("lease_token"),
  leaseUntil: time("lease_until"),
  retryAfter: time("retry_after"),
  createdAt: time("created_at").notNull(),
  updatedAt: time("updated_at").notNull(),
});
export const blobErasureAttempt = pgTable("blob_erasure_attempt", {
  id: text("id").primaryKey(),
  storageKey: text("storage_key").notNull(),
  status: text("status").notNull(),
  occurredAt: time("occurred_at").notNull(),
});
