import type {
  ApiError,
  AuthorizationService,
  Receipt,
  Result,
  SourceEnvelope,
  SourceRepository,
  TenantContext,
} from "@relay/contracts";
import { sourceEnvelopeSchema } from "@relay/contracts";
import { canonicalDigest, sourceReceivedEventId } from "./canonical.ts";
import type {
  SourceReceivedEvent,
  SourceStore,
  StoredRevision,
} from "./source-store.ts";

export interface SourceRepositoryDependencies {
  authorization: AuthorizationService;
  store: SourceStore;
  now?: () => Date;
}

type Failure = Extract<Result<never>, { ok: false }>;

function failure(
  code: ApiError["error"]["code"],
  message: string,
  correlationId: string,
  retryable = false,
): Failure {
  return { ok: false, error: { code, message, correlationId, retryable } };
}

function receiptOf(stored: StoredRevision): Receipt {
  return {
    sourceId: stored.sourceId,
    revision: stored.revision,
    status: "received",
    correlationId: stored.correlationId,
  };
}

function conflictMessage(
  reason: Extract<
    Awaited<ReturnType<SourceStore["insertRevision"]>>,
    { kind: "conflict" }
  >["reason"],
): string {
  switch (reason) {
    case "digest":
      return "Idempotency key was used with different content";
    case "revision":
      return "Source revision is not the next revision for this source";
    case "external-message":
      return "External message revision already belongs to another source";
    case "attachment-identity":
      return "Attachment identity does not match its stored metadata";
    default:
      return "Source revision conflicts with stored evidence";
  }
}

/**
 * Human-authorized source acceptance and evidence reads (ADR 0005).
 * Authorization is revalidated live on every call, before any stored evidence is
 * read or returned; a parsed context is never treated as authority.
 */
export function createSourceRepository({
  authorization,
  store,
  now = () => new Date(),
}: SourceRepositoryDependencies): SourceRepository {
  async function holdsReviewAuthority(
    context: TenantContext,
  ): Promise<boolean> {
    const review = await authorization.require(context, "review:write");
    return review.ok;
  }

  // Returns a denial for a submission, or null when the caller may submit it.
  async function submissionDenial(
    context: TenantContext,
    envelope: SourceEnvelope,
  ): Promise<Failure | null> {
    const correlationId = context.correlationId || "-";
    if (context.actor.kind === "system")
      return failure(
        "FORBIDDEN",
        "System actor cannot submit a source",
        correlationId,
      );
    // Cross-tenant writes are concealed as NOT_FOUND, never as a hint.
    if (envelope.organizationId !== context.organizationId)
      return failure("NOT_FOUND", "Organization not available", correlationId);

    const submit = await authorization.require(context, "source:submit");
    if (!submit.ok) return submit;

    const staff = await holdsReviewAuthority(context);
    if (!staff && envelope.author.membershipId !== context.actor.membershipId)
      return failure(
        "FORBIDDEN",
        "A volunteer may only submit as their own membership",
        correlationId,
      );
    return null;
  }

  // Returns a denial for reading evidence, or null plus staff status.
  async function evidenceAccess(
    context: TenantContext,
  ): Promise<{ denial: Failure } | { denial: null; staff: boolean }> {
    const correlationId = context.correlationId || "-";
    if (context.actor.kind === "system")
      return {
        denial: failure(
          "FORBIDDEN",
          "System actor cannot read source evidence",
          correlationId,
        ),
      };

    const staff = await holdsReviewAuthority(context);
    if (staff) return { denial: null, staff: true };

    // A report-reader holds report:read only and therefore gets no evidence
    // access at all; the denial happens before any existence lookup.
    const submit = await authorization.require(context, "source:submit");
    if (!submit.ok)
      return {
        denial: failure(
          "FORBIDDEN",
          "Role does not grant source evidence access",
          correlationId,
        ),
      };
    return { denial: null, staff: false };
  }

  return {
    async accept(context, source) {
      const correlationId = context.correlationId || "-";

      const parsed = sourceEnvelopeSchema.safeParse(source);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Source envelope is invalid",
          correlationId,
        );
      const envelope = parsed.data;

      const denial = await submissionDenial(context, envelope);
      if (denial) return denial;

      let digest: string;
      try {
        digest = canonicalDigest(envelope);
      } catch {
        return failure(
          "VALIDATION",
          "Source envelope is not canonicalizable",
          correlationId,
        );
      }

      const event: SourceReceivedEvent = {
        id: sourceReceivedEventId(
          envelope.organizationId,
          envelope.sourceId,
          envelope.revision,
        ),
        type: "source.received",
        organizationId: envelope.organizationId,
        aggregateId: envelope.sourceId,
        aggregateRevision: envelope.revision,
        payload: {
          sourceId: envelope.sourceId,
          sourceRevision: envelope.revision,
        },
        actor: context.actor,
        correlationId,
        occurredAt: now(),
      };

      let outcome: Awaited<ReturnType<SourceStore["insertRevision"]>>;
      try {
        outcome = await store.insertRevision(
          {
            organizationId: envelope.organizationId,
            sourceId: envelope.sourceId,
            revision: envelope.revision,
            channel: envelope.channel,
            channelIdentity: envelope.channelIdentity,
            externalMessageId: envelope.externalMessageId,
            idempotencyKey: envelope.idempotencyKey,
            authorExternalIdentity: envelope.author.externalIdentity,
            authorMembershipId: envelope.author.membershipId,
            occurredAt: envelope.occurredAt
              ? new Date(envelope.occurredAt)
              : null,
            receivedAt: new Date(envelope.receivedAt),
            timezone: envelope.timezone,
            text: envelope.text,
            originalMediaType: envelope.original.mediaType,
            originalPayload: envelope.original.payload,
            replyToSourceId: envelope.replyToSourceId,
            replacesRevision: envelope.replacesRevision,
            canonicalDigest: digest,
            // The exact validated envelope is preserved for evidence reads.
            envelope,
            // Stored as the first acceptance correlation; a replay returns this.
            correlationId,
            attachments: envelope.attachments.map((attachment) => ({
              id: attachment.id,
              storageKey: attachment.storageKey,
              sha256: attachment.sha256,
              mimeType: attachment.mimeType,
              bytes: attachment.bytes,
            })),
          },
          event,
        );
      } catch {
        // Storage failures surface as a bounded retryable error; driver detail
        // (which can contain source text) is never attached.
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Source storage is unavailable",
          correlationId,
          true,
        );
      }

      if (outcome.kind === "conflict")
        return failure(
          "CONFLICT",
          conflictMessage(outcome.reason),
          correlationId,
        );
      if (outcome.kind === "invalid-envelope")
        return failure(
          "VALIDATION",
          outcome.reason === "self-reply"
            ? "A source cannot reply to itself"
            : "Source envelope cannot be stored",
          correlationId,
        );
      if (outcome.kind === "invalid-target")
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              outcome.field === "author-membership"
                ? "Author membership is not part of this organization"
                : "Reply target is not part of this organization",
            correlationId,
            retryable: false,
            fields:
              outcome.field === "author-membership"
                ? { author: ["membershipId is not part of this organization"] }
                : { replyToSourceId: ["is not part of this organization"] },
          },
        };
      return { ok: true, value: receiptOf(outcome.stored) };
    },

    async get(context, sourceId, revision) {
      const correlationId = context.correlationId || "-";

      const access = await evidenceAccess(context);
      if (access.denial) return access.denial;

      const actor = context.actor;
      if (actor.kind === "system")
        // Defensive: evidenceAccess already denies system actors.
        return failure(
          "FORBIDDEN",
          "System actor cannot read source evidence",
          correlationId,
        );

      // A read-store failure must not escape the Result boundary with driver
      // detail; it becomes a fixed retryable dependency error.
      let stored: Awaited<ReturnType<SourceStore["findRevision"]>>;
      try {
        stored = await store.findRevision({
          organizationId: context.organizationId,
          sourceId,
          revision,
        });
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Source evidence is unavailable",
          correlationId,
          true,
        );
      }
      if (!stored)
        return failure("NOT_FOUND", "Source revision not found", correlationId);

      // An authorized non-staff reader gets NOT_FOUND for someone else's source,
      // exactly like an unknown or cross-tenant id.
      if (!access.staff && stored.authorMembershipId !== actor.membershipId)
        return failure("NOT_FOUND", "Source revision not found", correlationId);

      // Return the preserved envelope; timestamptz normalization never rewrites it.
      const preserved = sourceEnvelopeSchema.safeParse(stored.envelope);
      if (!preserved.success)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Stored source envelope is unavailable",
          correlationId,
          true,
        );
      return { ok: true, value: preserved.data };
    },
  };
}
