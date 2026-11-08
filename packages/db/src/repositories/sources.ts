import type { SourceEnvelope } from "@relay/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  member,
  outboxEvent,
  source,
  sourceAttachment,
  sourceAttachmentIdentity,
  sourceAuthor,
  sourceRevision,
} from "../schema/index.ts";
import type { Database } from "../types.ts";

// Structural mirrors of the ports declared in packages/domain/core. The db
// package does not depend on the domain package; the composition point
// type-checks this implementation against the port.

export interface StoredAttachmentRecord {
  id: string;
  storageKey: string;
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
}

export interface StoredRevisionRecord {
  organizationId: string;
  sourceId: string;
  revision: number;
  channel: "web" | "import" | "telegram";
  channelIdentity: string;
  externalMessageId: string;
  idempotencyKey: string;
  authorExternalIdentity: string;
  authorMembershipId: string | null;
  occurredAt: Date | null;
  receivedAt: Date;
  timezone: string;
  text: string;
  originalMediaType: string;
  originalPayload: string;
  replyToSourceId: string | null;
  replacesRevision: number | null;
  canonicalDigest: string;
  // Exact accepted envelope; reads return this verbatim.
  envelope: SourceEnvelope;
  correlationId: string;
  attachments: StoredAttachmentRecord[];
}

export interface SourceReceivedEventRecord {
  id: string;
  type: "source.received";
  organizationId: string;
  aggregateId: string;
  aggregateRevision: number;
  payload: { sourceId: string; sourceRevision: number };
  actor:
    | {
        kind: "user";
        userId: string;
        membershipId: string;
        role: "owner" | "coordinator" | "volunteer" | "report-reader";
      }
    | { kind: "system"; service: "worker" | "scheduler" };
  correlationId: string;
  occurredAt: Date;
}

export type RevisionInsertOutcomeRecord =
  | { kind: "inserted"; stored: StoredRevisionRecord }
  | { kind: "replay"; stored: StoredRevisionRecord }
  | {
      kind: "conflict";
      reason:
        | "digest"
        | "revision"
        | "external-message"
        | "attachment-identity";
    }
  | { kind: "invalid-target"; field: "author-membership" | "reply-source" }
  | {
      kind: "invalid-envelope";
      reason: "self-reply" | "predecessor" | "unspecified";
    };

export interface SourceStoreRecord {
  insertRevision(
    revision: StoredRevisionRecord,
    event: SourceReceivedEventRecord,
  ): Promise<RevisionInsertOutcomeRecord>;
  findRevision(key: {
    organizationId: string;
    sourceId: string;
    revision: number;
  }): Promise<StoredRevisionRecord | null>;
}

type RevisionRow = typeof sourceRevision.$inferSelect;
type QueryExecutor = Pick<Database, "select">;

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

function referenceTarget(error: unknown): "reply-source" | null {
  const constraint = pgErrorField(error, "constraint");
  if (constraint === "source_revision_reply_fk") return "reply-source";
  return null;
}

// Constraint failures are mapped to bounded outcomes; driver detail (which can
// contain row values, including source text) never becomes a public failure.
function checkViolationOutcome(
  error: unknown,
): RevisionInsertOutcomeRecord | null {
  const constraint = pgErrorField(error, "constraint") ?? "";
  if (constraint.includes("reply_check"))
    return { kind: "invalid-envelope", reason: "self-reply" };
  if (constraint.includes("sequence_check"))
    return { kind: "conflict", reason: "revision" };
  if (
    constraint.includes("attachment") ||
    constraint.includes("channel_check") ||
    constraint.includes("bytes_check") ||
    constraint.includes("mime_check") ||
    constraint.includes("digest_check")
  )
    return { kind: "invalid-envelope", reason: "unspecified" };
  return null;
}

function attachmentMetadataMatches(
  row: typeof sourceAttachmentIdentity.$inferSelect,
  attachment: StoredAttachmentRecord,
): boolean {
  return (
    row.storageKey === attachment.storageKey &&
    row.sha256 === attachment.sha256 &&
    row.mimeType === attachment.mimeType &&
    row.bytes === attachment.bytes
  );
}

function toAttachmentRecord(
  identity: typeof sourceAttachmentIdentity.$inferSelect,
): StoredAttachmentRecord {
  return {
    id: identity.attachmentId,
    storageKey: identity.storageKey,
    sha256: identity.sha256,
    mimeType: identity.mimeType as StoredAttachmentRecord["mimeType"],
    bytes: identity.bytes,
  };
}

async function attachmentsFor(
  executor: QueryExecutor,
  organizationId: string,
  sourceId: string,
  revision: number,
): Promise<StoredAttachmentRecord[]> {
  const rows = await executor
    .select({ identity: sourceAttachmentIdentity })
    .from(sourceAttachment)
    .innerJoin(
      sourceAttachmentIdentity,
      and(
        eq(
          sourceAttachmentIdentity.organizationId,
          sourceAttachment.organizationId,
        ),
        eq(sourceAttachmentIdentity.sourceId, sourceAttachment.sourceId),
        eq(
          sourceAttachmentIdentity.attachmentId,
          sourceAttachment.attachmentId,
        ),
      ),
    )
    .where(
      and(
        eq(sourceAttachment.organizationId, organizationId),
        eq(sourceAttachment.sourceId, sourceId),
        eq(sourceAttachment.revision, revision),
      ),
    )
    .orderBy(sourceAttachmentIdentity.attachmentId);
  return rows.map((row) => toAttachmentRecord(row.identity));
}

function toRevisionRecord(
  row: RevisionRow,
  attachments: StoredAttachmentRecord[],
): StoredRevisionRecord {
  return {
    organizationId: row.organizationId,
    sourceId: row.sourceId,
    revision: row.revision,
    channel: row.channel as StoredRevisionRecord["channel"],
    channelIdentity: row.channelIdentity,
    externalMessageId: row.externalMessageId,
    idempotencyKey: row.idempotencyKey,
    authorExternalIdentity: row.authorExternalIdentity,
    authorMembershipId: row.authorMembershipId,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    timezone: row.timezone,
    text: row.textBody,
    originalMediaType: row.originalMediaType,
    originalPayload: row.originalPayload,
    replyToSourceId: row.replyToSourceId,
    replacesRevision: row.replacesRevision,
    canonicalDigest: row.canonicalDigest,
    envelope: row.envelope,
    correlationId: row.correlationId,
    attachments,
  };
}

const insertSourceIdentity = (organizationId: string, sourceId: string) =>
  sql`insert into ${source} (organization_id, id) values (${organizationId}, ${sourceId}) on conflict do nothing`;

const lockSourceIdentity = (organizationId: string, sourceId: string) =>
  sql`select organization_id from ${source} where organization_id = ${organizationId} and id = ${sourceId} for update`;

const authorMembershipExists = (organizationId: string, membershipId: string) =>
  sql`select 1 from ${member} where organization_id = ${organizationId} and id = ${membershipId}`;

/**
 * Tenant-scoped source persistence. Uniqueness, the revision chain, immutable
 * attachment identity and source/outbox atomicity are enforced by the database,
 * so concurrent accepts are safe without process-local locks.
 */
// Thrown to abort the transaction when the outcome is decided before the write,
// so an early replay/conflict leaves nothing behind.
class OutcomeRollback extends Error {
  readonly outcome: RevisionInsertOutcomeRecord;
  constructor(outcome: RevisionInsertOutcomeRecord) {
    super("transaction rolled back to report an outcome");
    this.name = "OutcomeRollback";
    this.outcome = outcome;
  }
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function existingRevisionForKey(
  tx: QueryExecutor,
  revision: StoredRevisionRecord,
): Promise<RevisionRow | null> {
  const rows = await tx
    .select()
    .from(sourceRevision)
    .where(
      and(
        eq(sourceRevision.organizationId, revision.organizationId),
        eq(sourceRevision.channel, revision.channel),
        eq(sourceRevision.channelIdentity, revision.channelIdentity),
        eq(sourceRevision.idempotencyKey, revision.idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Validates the mapped membership in the source tenant, then upserts the stable
// historical author anchor. Revocation clears only the nullable live pointer.
async function ensureAuthorAnchor(
  tx: Tx,
  revision: StoredRevisionRecord,
): Promise<void> {
  if (revision.authorMembershipId === null) return;
  const authorRows = await tx.execute(
    authorMembershipExists(
      revision.organizationId,
      revision.authorMembershipId,
    ),
  );
  if (authorRows.rows.length === 0)
    throw new OutcomeRollback({
      kind: "invalid-target",
      field: "author-membership",
    });
  await tx
    .insert(sourceAuthor)
    .values({
      organizationId: revision.organizationId,
      membershipId: revision.authorMembershipId,
      currentMembershipId: revision.authorMembershipId,
    })
    .onConflictDoUpdate({
      target: [sourceAuthor.organizationId, sourceAuthor.membershipId],
      set: { currentMembershipId: revision.authorMembershipId },
    });
}

// A revision > 1 must name exactly its immediate predecessor; a first revision
// must not name one. Missing or wrong predecessors are conflicts, never effects.
function assertPredecessor(revision: StoredRevisionRecord): void {
  const isFirst = revision.revision === 1;
  const expected = revision.revision - 1;
  if (isFirst) {
    if (revision.replacesRevision !== null)
      throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
    return;
  }
  if (revision.replacesRevision === null)
    throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
  if (revision.replacesRevision !== expected)
    throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
}

// Enforces the sequential revision chain and stable channel/author identity.
async function assertRevisionChain(
  tx: Tx,
  revision: StoredRevisionRecord,
): Promise<void> {
  const latestRows = await tx
    .select({ revision: sourceRevision.revision })
    .from(sourceRevision)
    .where(
      and(
        eq(sourceRevision.organizationId, revision.organizationId),
        eq(sourceRevision.sourceId, revision.sourceId),
      ),
    )
    .orderBy(desc(sourceRevision.revision))
    .limit(1);
  const latest = latestRows[0]?.revision ?? null;
  const expectedPrevious = revision.revision - 1;

  if (revision.revision === 1) {
    if (latest !== null)
      throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
    return;
  }
  // The latest stored revision must be exactly the named predecessor.
  if (latest !== expectedPrevious)
    throw new OutcomeRollback({ kind: "conflict", reason: "revision" });

  const previousRows = await tx
    .select()
    .from(sourceRevision)
    .where(
      and(
        eq(sourceRevision.organizationId, revision.organizationId),
        eq(sourceRevision.sourceId, revision.sourceId),
        eq(sourceRevision.revision, expectedPrevious),
      ),
    )
    .limit(1);
  const previous = previousRows[0];
  if (
    !previous ||
    previous.channel !== revision.channel ||
    previous.channelIdentity !== revision.channelIdentity ||
    previous.externalMessageId !== revision.externalMessageId ||
    previous.authorExternalIdentity !== revision.authorExternalIdentity ||
    previous.authorMembershipId !== revision.authorMembershipId
  )
    throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
}

// Attachment identity is immutable per tenant + source across revisions.
async function ensureAttachmentIdentities(
  tx: Tx,
  revision: StoredRevisionRecord,
): Promise<void> {
  for (const attachment of revision.attachments) {
    const inconsistent = await tx.execute(
      sql`select 1 from source_attachment_identity where storage_key=${attachment.storageKey} and sha256<>${attachment.sha256} limit 1`,
    );
    if (inconsistent.rows.length)
      throw new OutcomeRollback({
        kind: "conflict",
        reason: "attachment-identity",
      });
    const created = await tx
      .insert(sourceAttachmentIdentity)
      .values({
        organizationId: revision.organizationId,
        sourceId: revision.sourceId,
        attachmentId: attachment.id,
        storageKey: attachment.storageKey,
        sha256: attachment.sha256,
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
      })
      .onConflictDoNothing()
      .returning();
    if (created.length > 0) continue;

    const existingRows = await tx
      .select()
      .from(sourceAttachmentIdentity)
      .where(
        and(
          eq(sourceAttachmentIdentity.organizationId, revision.organizationId),
          eq(sourceAttachmentIdentity.sourceId, revision.sourceId),
          eq(sourceAttachmentIdentity.attachmentId, attachment.id),
        ),
      )
      .limit(1);
    const existingIdentity = existingRows[0];
    if (
      !existingIdentity ||
      !attachmentMetadataMatches(existingIdentity, attachment)
    )
      throw new OutcomeRollback({
        kind: "conflict",
        reason: "attachment-identity",
      });
  }
}

export function createSourceStore(db: Database): SourceStoreRecord {
  async function findByKey(
    revision: StoredRevisionRecord,
  ): Promise<RevisionRow | null> {
    return existingRevisionForKey(db, revision);
  }

  async function findByExternalMessage(
    revision: StoredRevisionRecord,
  ): Promise<RevisionRow | null> {
    const rows = await db
      .select()
      .from(sourceRevision)
      .where(
        and(
          eq(sourceRevision.organizationId, revision.organizationId),
          eq(sourceRevision.channel, revision.channel),
          eq(sourceRevision.channelIdentity, revision.channelIdentity),
          eq(sourceRevision.externalMessageId, revision.externalMessageId),
          eq(sourceRevision.revision, revision.revision),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  // After a unique-violation rollback, classify the outcome from the winning row.
  async function classifyConflict(
    revision: StoredRevisionRecord,
    constraint: string | undefined,
  ): Promise<RevisionInsertOutcomeRecord> {
    if (constraint?.startsWith("source_attachment"))
      return { kind: "conflict", reason: "attachment-identity" };
    const sameKey = await findByKey(revision);
    if (sameKey) {
      const stored = toRevisionRecord(
        sameKey,
        await attachmentsFor(
          db,
          sameKey.organizationId,
          sameKey.sourceId,
          sameKey.revision,
        ),
      );
      return stored.canonicalDigest === revision.canonicalDigest
        ? { kind: "replay", stored }
        : { kind: "conflict", reason: "digest" };
    }
    if (await findByExternalMessage(revision))
      return { kind: "conflict", reason: "external-message" };
    return { kind: "conflict", reason: "revision" };
  }

  async function writeRevision(
    tx: Tx,
    revision: StoredRevisionRecord,
    event: SourceReceivedEventRecord,
  ): Promise<StoredRevisionRecord> {
    const insertedRows = await tx
      .insert(sourceRevision)
      .values({
        organizationId: revision.organizationId,
        sourceId: revision.sourceId,
        revision: revision.revision,
        channel: revision.channel,
        channelIdentity: revision.channelIdentity,
        externalMessageId: revision.externalMessageId,
        idempotencyKey: revision.idempotencyKey,
        authorExternalIdentity: revision.authorExternalIdentity,
        authorMembershipId: revision.authorMembershipId,
        occurredAt: revision.occurredAt,
        receivedAt: revision.receivedAt,
        timezone: revision.timezone,
        textBody: revision.text,
        originalMediaType: revision.originalMediaType,
        originalPayload: revision.originalPayload,
        replyToSourceId: revision.replyToSourceId,
        replacesRevision: revision.replacesRevision,
        canonicalDigest: revision.canonicalDigest,
        envelope: revision.envelope,
        correlationId: revision.correlationId,
      })
      .returning();
    const inserted = insertedRows[0];
    if (!inserted) throw new Error("source revision insert returned no row");

    if (revision.attachments.length > 0) {
      const associations = revision.attachments.map((attachment) => ({
        organizationId: revision.organizationId,
        sourceId: revision.sourceId,
        revision: revision.revision,
        attachmentId: attachment.id,
      }));
      await tx.insert(sourceAttachment).values(associations);
    }

    await tx.insert(outboxEvent).values({
      id: event.id,
      organizationId: event.organizationId,
      type: event.type,
      aggregateId: event.aggregateId,
      aggregateRevision: event.aggregateRevision,
      payload: event.payload,
      actor: event.actor,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
    });

    return toRevisionRecord(inserted, revision.attachments);
  }

  async function runAccept(
    revision: StoredRevisionRecord,
    event: SourceReceivedEventRecord,
  ): Promise<RevisionInsertOutcomeRecord> {
    return db.transaction(async (tx) => {
      // Blob upload and erasure adapters use this same transaction-level lock.
      for (const key of [
        ...new Set(revision.attachments.map((entry) => entry.storageKey)),
      ].sort())
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"blob:"} || ${key},0))`,
        );
      // Identity row is created once, then locked so concurrent appends of the
      // same source serialize inside the database.
      await tx.execute(
        insertSourceIdentity(revision.organizationId, revision.sourceId),
      );
      const locked = await tx.execute(
        lockSourceIdentity(revision.organizationId, revision.sourceId),
      );
      if (locked.rows.length === 0)
        throw new Error("source identity row missing after upsert");

      const redacted = await tx.execute(
        sql`select 1 from source_redaction where organization_id=${revision.organizationId} and source_id=${revision.sourceId}`,
      );
      if (redacted.rows.length)
        throw new OutcomeRollback({ kind: "conflict", reason: "revision" });
      // Classify an existing idempotency key BEFORE any new-target validation:
      // a still-authorized caller replaying an accepted envelope must get the
      // original receipt even if the historical author has since left.
      const existingRow = await existingRevisionForKey(tx, revision);
      if (existingRow) {
        const stored = toRevisionRecord(
          existingRow,
          await attachmentsFor(
            tx,
            existingRow.organizationId,
            existingRow.sourceId,
            existingRow.revision,
          ),
        );
        throw new OutcomeRollback(
          stored.canonicalDigest === revision.canonicalDigest
            ? { kind: "replay", stored }
            : { kind: "conflict", reason: "digest" },
        );
      }

      // New acceptance: the mapped author must exist in the source tenant now.
      await ensureAuthorAnchor(tx, revision);
      assertPredecessor(revision);
      await assertRevisionChain(tx, revision);
      await ensureAttachmentIdentities(tx, revision);

      return {
        kind: "inserted",
        stored: await writeRevision(tx, revision, event),
      };
    });
  }

  return {
    async insertRevision(revision, event) {
      try {
        return await runAccept(revision, event);
      } catch (error) {
        if (error instanceof OutcomeRollback) return error.outcome;
        const code = pgErrorField(error, "code");
        if (code === "23505")
          return classifyConflict(revision, pgErrorField(error, "constraint"));
        if (code === "23503") {
          const field = referenceTarget(error);
          if (field) return { kind: "invalid-target", field };
        }
        if (code === "23514") {
          const mapped = checkViolationOutcome(error);
          if (mapped) return mapped;
        }
        // Unexpected storage failure: a fixed message with no driver cause, so
        // no envelope text or PostgreSQL detail can reach the caller.
        throw new Error("source storage failure");
      }
    },

    async findRevision({ organizationId, sourceId, revision }) {
      const redacted = await db.execute(
        sql`select 1 from source_redaction where organization_id=${organizationId} and source_id=${sourceId}`,
      );
      if (redacted.rows.length) return null;
      const rows = await db
        .select()
        .from(sourceRevision)
        .where(
          and(
            eq(sourceRevision.organizationId, organizationId),
            eq(sourceRevision.sourceId, sourceId),
            eq(sourceRevision.revision, revision),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return toRevisionRecord(
        row,
        await attachmentsFor(db, organizationId, sourceId, revision),
      );
    },
  };
}
