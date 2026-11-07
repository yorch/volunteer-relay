import type { SourceEnvelope, TenantContext } from "@relay/contracts";

export interface StoredAttachment {
  id: string;
  storageKey: string;
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
}

export interface StoredRevision {
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
  // Exact accepted envelope; reads return this, not a rebuilt projection.
  envelope: SourceEnvelope;
  correlationId: string;
  attachments: StoredAttachment[];
}

export interface RevisionInsert extends StoredRevision {}

export interface SourceReceivedEvent {
  id: string;
  type: "source.received";
  organizationId: string;
  aggregateId: string;
  aggregateRevision: number;
  payload: { sourceId: string; sourceRevision: number };
  actor: TenantContext["actor"];
  correlationId: string;
  occurredAt: Date;
}

export type RevisionInsertOutcome =
  | { kind: "inserted"; stored: StoredRevision }
  | { kind: "replay"; stored: StoredRevision }
  | {
      kind: "conflict";
      reason:
        | "digest"
        | "revision"
        | "external-message"
        | "attachment-identity";
    }
  | { kind: "invalid-target"; field: "author-membership" | "reply-source" };

/**
 * Storage port for source persistence. The implementation owns transactionality
 * and the database uniqueness rules; the domain layer owns authorization and
 * canonicalization. Implemented by packages/db and composed at the call site.
 */
export interface SourceStore {
  insertRevision(
    revision: RevisionInsert,
    event: SourceReceivedEvent,
  ): Promise<RevisionInsertOutcome>;
  findRevision(key: {
    organizationId: string;
    sourceId: string;
    revision: number;
  }): Promise<StoredRevision | null>;
}
