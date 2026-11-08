import { z } from "zod";

export * from "./product.ts";

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

// M1 onboarding transport shapes; identity and membership remain server decisions.
export const authSignUpCommandSchema = z
  .object({
    name: z.string().min(1).max(200),
    email: z.email(),
    password: z.string().min(1),
  })
  .strict();
export type AuthSignUpCommand = z.infer<typeof authSignUpCommandSchema>;
export const authVerificationRequestSchema = z
  .object({ email: z.email() })
  .strict();
export type AuthVerificationRequest = z.infer<
  typeof authVerificationRequestSchema
>;
export const authVerificationConfirmSchema = z.object({ token: id }).strict();
export type AuthVerificationConfirm = z.infer<
  typeof authVerificationConfirmSchema
>;
export const authOrganizationChoicesSchema = z
  .object({
    currentOrganizationId: id.nullable(),
    options: z.array(authOrganizationOptionSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.options.map((option) => option.organizationId);
    if (
      new Set(ids).size !== ids.length ||
      (value.currentOrganizationId !== null &&
        !ids.includes(value.currentOrganizationId))
    )
      ctx.addIssue({
        code: "custom",
        message: "Organization selection must match unique current choices",
      });
  });
export type AuthOrganizationChoices = z.infer<
  typeof authOrganizationChoicesSchema
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
    replacementItems: z.array(proposalItemSchema).max(100).optional(),
  })
  .strict()
  .superRefine((command, ctx) => {
    if (
      command.replacementItems !== undefined &&
      (command.decision !== "accept" || command.reason.trim().length === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Edited acceptance requires a staff reason",
      });
  });
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
// Attachment identity is organization + source + attachment (ADR 0005), so a
// read names the source; evidence access rules match SourceRepository.get.
export interface AttachmentStore {
  read(
    context: TenantContext,
    sourceId: string,
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

// M1 ledger and need persistence (ADR 0009). Records are authorized
// projections; commands grant no authority and every operation re-checks live
// membership. Approved contributions are the reporting ledger.
const positiveInt = z.number().int().positive();
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "Text is required");
const label = boundedText(100);
const reasonText = boundedText(2000);
// Integer minutes for one person's contribution to one activity. Unknown is
// null, never zero.
export const contributionMinutesSchema = z.number().int().positive().max(1440);

export const recordOriginSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("source"),
      sourceId: id,
      sourceRevision: positiveInt,
    })
    .strict(),
  z.object({ kind: z.literal("staff"), reason: reasonText }).strict(),
]);
export type RecordOrigin = z.infer<typeof recordOriginSchema>;

const activityFacts = {
  kind: label,
  localDate: z.iso.date().nullable(),
  datePrecision: z.enum(["day", "unknown"]),
  beneficiaryReference: boundedText(200).nullable(),
};
function requireMatchingPrecision(
  value: { localDate: string | null; datePrecision: "day" | "unknown" },
  ctx: z.RefinementCtx,
): void {
  if ((value.localDate === null) !== (value.datePrecision === "unknown"))
    ctx.addIssue({
      code: "custom",
      message: "localDate is required exactly when datePrecision is day",
    });
}

export const activityRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: id,
    activityId: id,
    revision: positiveInt,
    ...activityFacts,
    origin: recordOriginSchema,
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .superRefine(requireMatchingPrecision);
export type ActivityRecord = z.infer<typeof activityRecordSchema>;

export const contributionRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: id,
    contributionId: id,
    activityId: id,
    revision: positiveInt,
    membershipId: id.nullable(),
    durationMinutes: contributionMinutesSchema.nullable(),
    status: contributionStatusSchema,
    origin: recordOriginSchema,
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.status === "approved" &&
      (record.membershipId === null || record.durationMinutes === null)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Approved contributions need a resolved volunteer and duration",
      });
  });
export type ContributionRecord = z.infer<typeof contributionRecordSchema>;

export const recordedActivitySchema = z
  .object({
    activity: activityRecordSchema,
    contributions: z.array(contributionRecordSchema),
  })
  .strict();
export type RecordedActivity = z.infer<typeof recordedActivitySchema>;

// Aggregate-only projection for report:read; contains no evidence.
export const ledgerSummarySchema = z
  .object({
    approvedMinutes: z.number().int().nonnegative(),
    approvedContributions: z.number().int().nonnegative(),
    activitiesWithApprovedContributions: z.number().int().nonnegative(),
    pendingContributions: z.number().int().nonnegative(),
    pendingUnknownDuration: z.number().int().nonnegative(),
    pendingUnresolvedVolunteer: z.number().int().nonnegative(),
  })
  .strict();
export type LedgerSummary = z.infer<typeof ledgerSummarySchema>;

const commandBase = { schemaVersion: z.literal(1), idempotencyKey: id };
const contributionDraftSchema = z
  .object({
    membershipId: id.nullable(),
    durationMinutes: contributionMinutesSchema.nullable(),
  })
  .strict();

export const recordActivityCommandSchema = z
  .object({
    ...commandBase,
    ...activityFacts,
    origin: recordOriginSchema,
    contributions: z.array(contributionDraftSchema).max(20),
  })
  .strict()
  .superRefine((command, ctx) => {
    requireMatchingPrecision(command, ctx);
    const members = command.contributions
      .map((draft) => draft.membershipId)
      .filter((value): value is string => value !== null);
    if (new Set(members).size !== members.length)
      ctx.addIssue({
        code: "custom",
        message: "A volunteer appears at most once per activity",
      });
  });
export type RecordActivityCommand = z.infer<typeof recordActivityCommandSchema>;

export const reviseActivityCommandSchema = z
  .object({
    ...commandBase,
    activityId: id,
    expectedRevision: positiveInt,
    ...activityFacts,
    reason: reasonText,
  })
  .strict()
  .superRefine(requireMatchingPrecision);
export type ReviseActivityCommand = z.infer<typeof reviseActivityCommandSchema>;

export const addContributionCommandSchema = z
  .object({
    ...commandBase,
    activityId: id,
    ...contributionDraftSchema.shape,
    origin: recordOriginSchema,
  })
  .strict();
export type AddContributionCommand = z.infer<
  typeof addContributionCommandSchema
>;

const contributionTarget = {
  ...commandBase,
  contributionId: id,
  expectedRevision: positiveInt,
};
export const contributionTransitionSchema = z.discriminatedUnion("action", [
  z.object({ ...contributionTarget, action: z.literal("approve") }).strict(),
  z
    .object({
      ...contributionTarget,
      action: z.literal("reject"),
      reason: reasonText,
    })
    .strict(),
  z
    .object({
      ...contributionTarget,
      action: z.literal("correct"),
      durationMinutes: contributionMinutesSchema,
      reason: reasonText,
    })
    .strict(),
  z
    .object({
      ...contributionTarget,
      action: z.literal("supersede"),
      reason: reasonText,
    })
    .strict(),
]);
export type ContributionTransition = z.infer<
  typeof contributionTransitionSchema
>;
type ContributionStatus = z.infer<typeof contributionStatusSchema>;
// to: null keeps the current status (a correction amends in place).
export const contributionTransitionRules = {
  approve: { from: ["pending"], to: "approved" },
  reject: { from: ["pending"], to: "rejected" },
  correct: { from: ["pending", "approved"], to: null },
  supersede: { from: ["pending", "approved"], to: "superseded" },
} as const satisfies Record<
  ContributionTransition["action"],
  { from: readonly ContributionStatus[]; to: ContributionStatus | null }
>;

const listLimit = z.number().int().min(1).max(100).optional();
export const contributionListQuerySchema = z
  .object({ status: contributionStatusSchema.optional(), limit: listLimit })
  .strict();
export type ContributionListQuery = z.infer<typeof contributionListQuerySchema>;

type NeedStatus = z.infer<typeof needStatusSchema>;
export const needRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: id,
    needId: id,
    revision: positiveInt,
    category: label,
    urgency: urgencySchema,
    summary: reasonText,
    provisional: z.boolean(),
    status: needStatusSchema,
    ownerMembershipId: id.nullable(),
    dueAt: instant.nullable(),
    acknowledgeBy: instant.nullable(),
    acknowledgedAt: instant.nullable(),
    acknowledgedByMembershipId: id.nullable(),
    resolvedAt: instant.nullable(),
    resolution: reasonText.nullable(),
    origin: recordOriginSchema,
    createdAt: instant,
    updatedAt: instant,
  })
  .strict()
  .superRefine((need, ctx) => {
    const owned = need.ownerMembershipId !== null;
    const acknowledged =
      need.acknowledgedAt !== null && need.acknowledgedByMembershipId !== null;
    const unacknowledged =
      need.acknowledgedAt === null && need.acknowledgedByMembershipId === null;
    const resolved = need.resolvedAt !== null && need.resolution !== null;
    const unresolved = need.resolvedAt === null && need.resolution === null;
    const consistent = {
      new: !owned && unacknowledged && unresolved,
      assigned: owned && unacknowledged && unresolved,
      acknowledged: owned && acknowledged && unresolved,
      resolved: resolved && (acknowledged || unacknowledged),
      cancelled: unresolved && (acknowledged || unacknowledged),
    }[need.status];
    if (!consistent)
      ctx.addIssue({
        code: "custom",
        message: "Need fields are inconsistent with its status",
      });
  });
export type NeedRecord = z.infer<typeof needRecordSchema>;

export const createNeedCommandSchema = z
  .object({
    ...commandBase,
    category: label,
    urgency: urgencySchema,
    summary: reasonText,
    provisional: z.boolean(),
    dueAt: instant.nullable(),
    acknowledgeBy: instant.nullable(),
    origin: recordOriginSchema,
  })
  .strict();
export type CreateNeedCommand = z.infer<typeof createNeedCommandSchema>;

const needTarget = {
  ...commandBase,
  needId: id,
  expectedRevision: positiveInt,
};
export const needTransitionSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...needTarget,
      action: z.literal("assign"),
      ownerMembershipId: id,
      acknowledgeBy: instant.nullable(),
    })
    .strict(),
  z.object({ ...needTarget, action: z.literal("acknowledge") }).strict(),
  z
    .object({
      ...needTarget,
      action: z.literal("resolve"),
      resolution: reasonText,
    })
    .strict(),
  z
    .object({ ...needTarget, action: z.literal("cancel"), reason: reasonText })
    .strict(),
  z
    .object({ ...needTarget, action: z.literal("reopen"), reason: reasonText })
    .strict(),
]);
export type NeedTransition = z.infer<typeof needTransitionSchema>;
// Reopen returns to new and clears owner/acknowledgment for explicit routing.
export const needTransitionRules = {
  assign: { from: ["new", "assigned", "acknowledged"], to: "assigned" },
  acknowledge: { from: ["assigned"], to: "acknowledged" },
  resolve: { from: ["new", "assigned", "acknowledged"], to: "resolved" },
  cancel: { from: ["new", "assigned", "acknowledged"], to: "cancelled" },
  reopen: { from: ["resolved", "cancelled"], to: "new" },
} as const satisfies Record<
  NeedTransition["action"],
  { from: readonly NeedStatus[]; to: NeedStatus }
>;

export const needListQuerySchema = z
  .object({ status: needStatusSchema.optional(), limit: listLimit })
  .strict();
export type NeedListQuery = z.infer<typeof needListQuerySchema>;

// Staff (review:write) operate the ledger; volunteers list only their own
// contributions; report:read receives aggregates only.
export interface LedgerService {
  recordActivity(
    context: TenantContext,
    command: RecordActivityCommand,
  ): Promise<Result<RecordedActivity>>;
  reviseActivity(
    context: TenantContext,
    command: ReviseActivityCommand,
  ): Promise<Result<ActivityRecord>>;
  addContribution(
    context: TenantContext,
    command: AddContributionCommand,
  ): Promise<Result<ContributionRecord>>;
  transitionContribution(
    context: TenantContext,
    command: ContributionTransition,
  ): Promise<Result<ContributionRecord>>;
  getActivity(
    context: TenantContext,
    activityId: string,
  ): Promise<Result<RecordedActivity>>;
  listContributions(
    context: TenantContext,
    query: ContributionListQuery,
  ): Promise<Result<ContributionRecord[]>>;
  summarize(context: TenantContext): Promise<Result<LedgerSummary>>;
}

// need:manage operates needs; only the current owner acknowledges.
export interface NeedService {
  create(
    context: TenantContext,
    command: CreateNeedCommand,
  ): Promise<Result<NeedRecord>>;
  transition(
    context: TenantContext,
    command: NeedTransition,
  ): Promise<Result<NeedRecord>>;
  get(context: TenantContext, needId: string): Promise<Result<NeedRecord>>;
  list(
    context: TenantContext,
    query: NeedListQuery,
  ): Promise<Result<NeedRecord[]>>;
}
