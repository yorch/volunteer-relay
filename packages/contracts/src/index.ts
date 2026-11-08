import { z } from "zod";

export const CONTRACT_VERSION = 1 as const;
export const needStatusSchema = z.enum([
  "new",
  "assigned",
  "acknowledged",
  "resolved",
  "cancelled",
]);
export const urgencySchema = z.enum(["routine", "urgent"]);
export const automationPolicySchema = z.enum([
  "review-all",
  "validated-auto-record",
]);
export const contributionStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
]);
const id = z.string().min(1);
const instant = z.iso.datetime({ offset: true });
export const roleSchema = z.enum([
  "owner",
  "coordinator",
  "volunteer",
  "report-reader",
]);
export type ContractRole = z.infer<typeof roleSchema>;
export const authOrganizationOptionSchema = z
  .object({
    organizationId: id,
    name: id,
    slug: id,
    role: roleSchema,
    membershipId: id,
  })
  .strict();
export type AuthOrganizationOption = z.infer<
  typeof authOrganizationOptionSchema
>;

// UI commands are inputs, never proof of session, membership or token validity.
export const authSignInCommandSchema = z
  .object({ email: z.email(), password: z.string().min(1) })
  .strict();
export type AuthSignInCommand = z.infer<typeof authSignInCommandSchema>;
export const authResetRequestSchema = z.object({ email: z.email() }).strict();
export type AuthResetRequest = z.infer<typeof authResetRequestSchema>;
export const authResetConfirmSchema = z
  .object({ token: id, newPassword: z.string().min(1) })
  .strict();
export type AuthResetConfirm = z.infer<typeof authResetConfirmSchema>;
export const authOrganizationSelectionSchema = z
  .object({ organizationId: id })
  .strict();
export type AuthOrganizationSelection = z.infer<
  typeof authOrganizationSelectionSchema
>;
export const authInvitationAcceptanceSchema = z
  .object({ invitationId: id })
  .strict();
export type AuthInvitationAcceptance = z.infer<
  typeof authInvitationAcceptanceSchema
>;

export const tenantContextSchema = z
  .object({
    organizationId: id,
    actor: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("user"),
        userId: id,
        membershipId: id,
        role: roleSchema,
      }),
      z.object({
        kind: z.literal("system"),
        service: z.enum(["worker", "scheduler"]),
      }),
    ]),
    correlationId: id,
  })
  .strict();
export type TenantContext = z.infer<typeof tenantContextSchema>;
export const attachmentSchema = z
  .object({
    id,
    organizationId: id,
    storageKey: id,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    bytes: z.number().int().positive(),
  })
  .strict();
export const sourceEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: id,
    sourceId: id,
    revision: z.number().int().positive(),
    channel: z.enum(["web", "import", "telegram"]),
    channelIdentity: id,
    externalMessageId: id,
    idempotencyKey: id,
    author: z
      .object({ externalIdentity: id, membershipId: id.nullable() })
      .strict(),
    occurredAt: instant.nullable(),
    receivedAt: instant,
    timezone: id,
    text: z.string(),
    attachments: z.array(attachmentSchema),
    replyToSourceId: id.nullable(),
    replacesRevision: z.number().int().positive().nullable(),
    original: z.object({ mediaType: id, payload: z.string() }).strict(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (
      source.attachments.some((a) => a.organizationId !== source.organizationId)
    )
      ctx.addIssue({ code: "custom", message: "Attachment tenant mismatch" });
    if (
      source.replacesRevision !== null &&
      source.replacesRevision >= source.revision
    )
      ctx.addIssue({
        code: "custom",
        message: "Replacement must reference an earlier revision",
      });
  });
export type SourceEnvelope = z.infer<typeof sourceEnvelopeSchema>;
export const evidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      field: id,
      sourceId: id,
      sourceRevision: z.number().int().positive(),
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      quote: z.string().min(1),
    })
    .strict()
    .refine((e) => e.end > e.start, "Invalid evidence span"),
  z
    .object({
      kind: z.literal("attachment"),
      field: id,
      sourceId: id,
      sourceRevision: z.number().int().positive(),
      attachmentId: id,
      observation: z.string().min(1),
    })
    .strict(),
]);
const evidence = z.array(evidenceSchema).min(1);
export const proposalItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("activity"),
      key: id,
      activityKind: id,
      localDate: z.iso.date().nullable(),
      datePrecision: z.enum(["day", "unknown"]),
      beneficiaryReference: id.nullable(),
      evidence,
    })
    .strict(),
  z
    .object({
      kind: z.literal("contribution"),
      key: id,
      activityKey: id,
      membershipId: id.nullable(),
      durationMinutes: z.number().int().positive().nullable(),
      evidence,
    })
    .strict(),
  z
    .object({
      kind: z.literal("need"),
      key: id,
      category: id,
      urgency: urgencySchema,
      summary: z.string().min(1),
      provisional: z.boolean(),
      evidence,
    })
    .strict(),
  z
    .object({
      kind: z.literal("correction"),
      key: id,
      targetId: id.nullable(),
      expectedRevision: z.number().int().positive().nullable(),
      durationMinutes: z.number().int().positive().nullable(),
      reason: z.string().min(1),
      evidence,
    })
    .strict(),
]);
export const extractionProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: id,
    sourceId: id,
    sourceRevision: z.number().int().positive(),
    runId: id,
    modelVersion: id,
    promptVersion: id,
    policyVersion: id,
    items: z.array(proposalItemSchema),
    unresolved: z.array(z.object({ field: id, reason: id }).strict()),
  })
  .strict();
export type ExtractionProposal = z.infer<typeof extractionProposalSchema>;
export const errorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
  "RATE_LIMITED",
  "DEPENDENCY_UNAVAILABLE",
]);
export const apiErrorSchema = z
  .object({
    error: z
      .object({
        code: errorCodeSchema,
        message: id,
        correlationId: id,
        retryable: z.boolean(),
        fields: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ApiError["error"] };
export const receiptSchema = z
  .object({
    sourceId: id,
    revision: z.number().int().positive(),
    status: z.literal("received"),
    correlationId: id,
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
const eventBase = {
  schemaVersion: z.literal(1),
  eventId: id,
  organizationId: id,
  aggregateId: id,
  aggregateRevision: z.number().int().positive(),
  occurredAt: instant,
  correlationId: id,
  actor: tenantContextSchema.shape.actor,
};
export const domainEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...eventBase,
      type: z.literal("source.received"),
      payload: z
        .object({ sourceId: id, sourceRevision: z.number().int().positive() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("proposal.created"),
      payload: z.object({ runId: id, sourceId: id }).strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("need.changed"),
      payload: z
        .object({
          needId: id,
          status: needStatusSchema,
          provisional: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...eventBase,
      type: z.literal("ledger.changed"),
      payload: z
        .object({
          contributionId: id,
          reason: z.enum(["approved", "corrected", "superseded"]),
        })
        .strict(),
    })
    .strict(),
]);
export type DomainEvent = z.infer<typeof domainEventSchema>;

// Context is resolved server-side; parsing a context never proves authority.
export interface AuthorizationService {
  resolve(
    userId: string,
    organizationId: string,
    correlationId: string,
  ): Promise<Result<TenantContext>>;
  require(
    context: TenantContext,
    permission:
      | "source:submit"
      | "review:write"
      | "need:manage"
      | "report:read",
  ): Promise<Result<void>>;
}
export interface SourceRepository {
  // Atomically persists evidence + source.received outbox; repeated key returns original receipt.
  accept(
    context: TenantContext,
    source: SourceEnvelope,
  ): Promise<Result<Receipt>>;
  get(
    context: TenantContext,
    sourceId: string,
    revision: number,
  ): Promise<Result<SourceEnvelope>>;
}
export interface ExtractionService {
  extract(
    context: TenantContext,
    source: SourceEnvelope,
    versions: { model: string; prompt: string; policy: string },
  ): Promise<Result<ExtractionProposal>>;
}
// Text-only browser command; tenant, author, source identity and timestamps
// are resolved by the future authenticated server adapter, never this body.
export const webSourceSubmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    idempotencyKey: id,
    text: z
      .string()
      .min(1)
      .refine((text) => text.length <= 20000, "Text exceeds the size limit")
      .refine((text) => text.trim().length > 0, "Text is required"),
  })
  .strict();
export type WebSourceSubmission = z.infer<typeof webSourceSubmissionSchema>;

// Names the existing wire shape without changing ReviewService's API.
export const reviewDecisionSchema = z
  .object({
    runId: id,
    expectedRevision: z.number().int().positive(),
    idempotencyKey: id,
    decision: z.enum(["accept", "reject"]),
    reason: z.string(),
  })
  .strict();
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;
export const reviewOutcomeSchema = z
  .object({ revision: z.number().int().positive() })
  .strict();
export type ReviewOutcome = z.infer<typeof reviewOutcomeSchema>;

// An authorized staff projection, not a browser-supplied authority or a
// persistence command. revision is the review aggregate revision.
export const reviewQueueEntrySchema = z
  .object({
    schemaVersion: z.literal(1),
    source: sourceEnvelopeSchema,
    proposal: extractionProposalSchema,
    revision: z.number().int().positive(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.source.organizationId !== entry.proposal.organizationId ||
      entry.source.sourceId !== entry.proposal.sourceId ||
      entry.source.revision !== entry.proposal.sourceRevision
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Source/proposal identity mismatch",
      });
    }
  });
export type ReviewQueueEntry = z.infer<typeof reviewQueueEntrySchema>;

export interface ReviewService {
  decide(
    context: TenantContext,
    command: ReviewDecision,
  ): Promise<Result<ReviewOutcome>>;
}
export interface CandidateRepository {
  find(
    context: TenantContext,
    source: SourceEnvelope,
  ): Promise<
    Result<Array<{ activityId: string; revision: number; reason: string }>>
  >;
}
export interface EventHandler {
  handle(context: TenantContext, event: DomainEvent): Promise<Result<void>>;
}
export interface AttachmentStore {
  read(
    context: TenantContext,
    attachmentId: string,
  ): Promise<Result<{ bytes: Uint8Array; mimeType: string }>>;
}
export interface NotificationTransport {
  deliver(
    context: TenantContext,
    message: {
      deliveryKey: string;
      recipientId: string;
      template: string;
      appPath: string;
    },
  ): Promise<Result<{ providerId: string; status: "accepted" }>>;
}
