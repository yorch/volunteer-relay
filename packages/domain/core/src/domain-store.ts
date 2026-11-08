import type {
  ActivityRecord,
  ContributionRecord,
  LedgerSummary,
  NeedRecord,
  TenantContext,
} from "@relay/contracts";

export interface AuditEntry {
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

export interface OutboxEntry {
  id: string;
  type: "ledger.changed" | "need.changed";
  aggregateId: string;
  aggregateRevision: number;
  payload: unknown;
  actor: TenantContext["actor"];
  correlationId: string;
  occurredAt: Date;
}

export type Write =
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

export interface DomainMutation {
  organizationId: string;
  command: {
    idempotencyKey: string;
    commandType: string;
    digest: string;
    result: unknown;
    correlationId: string;
  };
  // Membership ids newly referenced by this mutation; the store verifies each
  // is a live tenant member and upserts its source_author anchor.
  anchors: string[];
  writes: Write[];
  audit: AuditEntry[];
  events: OutboxEntry[];
}

export interface StoredCommand {
  commandType: string;
  digest: string;
  result: unknown;
}

export type CommitOutcome =
  | { kind: "committed" }
  | { kind: "replay"; command: StoredCommand }
  | {
      kind: "conflict";
      reason: "revision" | "duplicate-contribution" | "idempotency";
    }
  | { kind: "invalid-target"; field: "membership" | "origin" | "activity" };

/**
 * Storage port for M1 domain persistence (ADR 0009). The implementation owns
 * the transaction, optimistic revision checks and constraint classification;
 * the domain layer owns authorization, command parsing and record building.
 * Implemented by packages/db and composed at the call site.
 */
export interface DomainStore {
  findCommand(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<StoredCommand | null>;
  // Role of a live member row in the tenant, or null when absent.
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
  // Newest first, then id.
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
  commit(mutation: DomainMutation): Promise<CommitOutcome>;
}

// Metadata-only attachment lookup for the authorized blob boundary; bytes live
// behind an injected blob reader keyed by storageKey.
export interface StoredAttachmentMetadata {
  storageKey: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  authorMembershipId: string | null;
}

export interface AttachmentMetadataStore {
  find(
    organizationId: string,
    sourceId: string,
    attachmentId: string,
  ): Promise<StoredAttachmentMetadata | null>;
}
