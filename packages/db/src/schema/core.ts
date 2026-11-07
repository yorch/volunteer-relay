import type { SourceEnvelope, TenantContext } from "@relay/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { member, organization } from "./auth.ts";

const createdAt = timestamp("created_at", { withTimezone: true })
  .notNull()
  .defaultNow();

// Source identity is organization + sourceId (ADR 0005), so the tenant is part
// of every key. Two organizations may use the same sourceId independently.
export const source = pgTable(
  "source",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    createdAt,
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.id] })],
);

// Stable historical author reference. The recorded membership id never changes;
// the nullable pointer follows the live member row and is cleared when that
// membership is deleted (row-deletion revocation from P1-01). Only the pointer is
// nullable, so a single-column ON DELETE SET NULL cannot touch organization_id,
// and revocation never erases authored evidence.
export const sourceAuthor = pgTable(
  "source_author",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    membershipId: text("membership_id").notNull(),
    // Composite relation so a pointer cannot name another tenant's member; the
    // migration narrows ON DELETE SET NULL to this column only, so deletion
    // clears the pointer without touching organization_id.
    //
    // TOOLING NOTE: Drizzle Kit 0.31.11 cannot express a column-specific
    // composite SET NULL (its schema emits a plain ON DELETE SET NULL for every
    // column). Migration 0001 is therefore hand-corrected to
    // `ON DELETE SET NULL (current_membership_id)` and MUST keep that form when
    // regenerated; a plain SET NULL would also attempt to null organization_id
    // and fail the not-null constraint. The catalog regression in
    // tests/integration/domain/source-author-pointer.test.ts pins this.
    currentMembershipId: text("current_membership_id"),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.membershipId] }),
    foreignKey({
      name: "source_author_current_membership_fk",
      columns: [table.organizationId, table.currentMembershipId],
      foreignColumns: [member.organizationId, member.id],
    }).onDelete("set null"),
  ],
);

// Immutable source revisions. The accepted envelope is preserved verbatim
// (including ISO offset strings) alongside relational projections used for
// constraints and lookups.
export const sourceRevision = pgTable(
  "source_revision",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    revision: integer("revision").notNull(),
    channel: text("channel").notNull(),
    channelIdentity: text("channel_identity").notNull(),
    externalMessageId: text("external_message_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    authorExternalIdentity: text("author_external_identity").notNull(),
    authorMembershipId: text("author_membership_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    textBody: text("text_body").notNull(),
    originalMediaType: text("original_media_type").notNull(),
    originalPayload: text("original_payload").notNull(),
    replyToSourceId: text("reply_to_source_id"),
    replacesRevision: integer("replaces_revision"),
    canonicalDigest: text("canonical_digest").notNull(),
    // Exact validated envelope as accepted; reads return this, not a rebuild.
    envelope: jsonb("envelope").$type<SourceEnvelope>().notNull(),
    // Correlation of the first acceptance; a replay returns this same receipt.
    correlationId: text("correlation_id").notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.sourceId, table.revision],
    }),
    check(
      "source_revision_channel_check",
      sql`${table.channel} in ('web', 'import', 'telegram')`,
    ),
    // A nullable predecessor on revision > 1 would evaluate to NULL and pass a
    // bare equality check, so non-nullness is part of the constraint.
    check(
      "source_revision_sequence_check",
      sql`(${table.revision} = 1 and ${table.replacesRevision} is null) or (${table.revision} > 1 and ${table.replacesRevision} is not null and ${table.replacesRevision} = ${table.revision} - 1)`,
    ),
    check(
      "source_revision_reply_check",
      sql`${table.replyToSourceId} is null or ${table.replyToSourceId} <> ${table.sourceId}`,
    ),
    // Canonical idempotency tuple: identical replay, or CONFLICT on a changed payload.
    uniqueIndex("source_revision_idempotency_unique").on(
      table.organizationId,
      table.channel,
      table.channelIdentity,
      table.idempotencyKey,
    ),
    // No other sourceId may impersonate the same external message revision.
    uniqueIndex("source_revision_external_message_unique").on(
      table.organizationId,
      table.channel,
      table.channelIdentity,
      table.externalMessageId,
      table.revision,
    ),
    index("source_revision_author_idx").on(
      table.organizationId,
      table.authorMembershipId,
    ),
    foreignKey({
      name: "source_revision_source_fk",
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [source.organizationId, source.id],
    }).onDelete("cascade"),
    // Historical author identity comes from the anchor, which survives revocation.
    foreignKey({
      name: "source_revision_author_reference_fk",
      columns: [table.organizationId, table.authorMembershipId],
      foreignColumns: [sourceAuthor.organizationId, sourceAuthor.membershipId],
    }),
    foreignKey({
      name: "source_revision_reply_fk",
      columns: [table.organizationId, table.replyToSourceId],
      foreignColumns: [source.organizationId, source.id],
    }),
  ],
);

// Attachment identity is immutable per tenant + source, independent of revision.
export const sourceAttachmentIdentity = pgTable(
  "source_attachment_identity",
  {
    organizationId: text("organization_id").notNull(),
    sourceId: text("source_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: text("sha256").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.sourceId, table.attachmentId],
    }),
    check(
      "source_attachment_identity_digest_check",
      sql`${table.sha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "source_attachment_identity_mime_check",
      sql`${table.mimeType} in ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check("source_attachment_identity_bytes_check", sql`${table.bytes} > 0`),
    foreignKey({
      name: "source_attachment_identity_source_fk",
      columns: [table.organizationId, table.sourceId],
      foreignColumns: [source.organizationId, source.id],
    }).onDelete("cascade"),
  ],
);

// Which attachment identities belong to which immutable revision.
export const sourceAttachment = pgTable(
  "source_attachment",
  {
    organizationId: text("organization_id").notNull(),
    sourceId: text("source_id").notNull(),
    revision: integer("revision").notNull(),
    attachmentId: text("attachment_id").notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({
      columns: [
        table.organizationId,
        table.sourceId,
        table.revision,
        table.attachmentId,
      ],
    }),
    foreignKey({
      name: "source_attachment_revision_fk",
      columns: [table.organizationId, table.sourceId, table.revision],
      foreignColumns: [
        sourceRevision.organizationId,
        sourceRevision.sourceId,
        sourceRevision.revision,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "source_attachment_identity_fk",
      columns: [table.organizationId, table.sourceId, table.attachmentId],
      foreignColumns: [
        sourceAttachmentIdentity.organizationId,
        sourceAttachmentIdentity.sourceId,
        sourceAttachmentIdentity.attachmentId,
      ],
    }).onDelete("cascade"),
  ],
);

// Pending durable work. Written in the same transaction as the revision; this
// slice performs no dispatch and no external side effect.
export const outboxEvent = pgTable(
  "outbox_event",
  {
    // Event identity is organization-scoped: the same event id may exist in
    // another tenant without colliding.
    id: text("id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    aggregateRevision: integer("aggregate_revision").notNull(),
    payload: jsonb("payload").notNull(),
    actor: jsonb("actor").$type<TenantContext["actor"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.id] }),
    check("outbox_event_type_check", sql`${table.type} in ('source.received')`),
    uniqueIndex("outbox_event_aggregate_unique").on(
      table.organizationId,
      table.type,
      table.aggregateId,
      table.aggregateRevision,
    ),
    index("outbox_event_pending_idx").on(
      table.organizationId,
      table.dispatchedAt,
    ),
    // Tenant-scoped reference to the exact source revision, not just the tenant.
    foreignKey({
      name: "outbox_event_source_revision_fk",
      columns: [
        table.organizationId,
        table.aggregateId,
        table.aggregateRevision,
      ],
      foreignColumns: [
        sourceRevision.organizationId,
        sourceRevision.sourceId,
        sourceRevision.revision,
      ],
    }).onDelete("cascade"),
  ],
);
