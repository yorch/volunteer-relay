import type {
  ActivityRecord,
  AuthorizationService,
  ContributionRecord,
  LedgerService,
  TenantContext,
} from "@relay/contracts";
import {
  activityRecordSchema,
  addContributionCommandSchema,
  contributionListQuerySchema,
  contributionRecordSchema,
  contributionTransitionRules,
  contributionTransitionSchema,
  recordActivityCommandSchema,
  recordedActivitySchema,
  reviseActivityCommandSchema,
} from "@relay/contracts";
import type { DomainStore } from "../domain-store.ts";
import { commandDigest, domainEventId } from "../shared/events.ts";
import { type Failure, failure } from "../shared/failure.ts";
import {
  checkIdempotentReplay,
  finalizeMutation,
  storageUnavailable,
} from "../shared/mutation.ts";

export interface LedgerServiceDependencies {
  authorization: AuthorizationService;
  store: DomainStore;
  now?: () => Date;
  ids?: () => string;
}

function forbiddenSystem(correlationId: string): Failure {
  return failure(
    "FORBIDDEN",
    "System actor cannot write the ledger",
    correlationId,
  );
}

function validationFields(field: string, correlationId: string): Failure {
  return failure(
    "VALIDATION",
    "A referenced record is not part of this organization",
    correlationId,
    false,
    { [field]: ["is not part of this organization"] },
  );
}

/**
 * Human-authorized ledger operations (ADR 0009). Authorization is revalidated
 * live on every call; idempotent replay is checked after authorization and
 * before revision/state checks, and every mutation commits its aggregate
 * write, audit row, command row and outbox event in one transaction.
 */
export function createLedgerService({
  authorization,
  store,
  now = () => new Date(),
  ids = () => crypto.randomUUID(),
}: LedgerServiceDependencies): LedgerService {
  async function requireStaff(context: TenantContext): Promise<Failure | null> {
    const correlationId = context.correlationId || "-";
    if (context.actor.kind === "system") return forbiddenSystem(correlationId);
    const required = await authorization.require(context, "review:write");
    if (!required.ok) return required;
    return null;
  }

  // Live members only: a referenced membership must still exist in the tenant.
  async function membershipLiveness(
    organizationId: string,
    membershipId: string,
    correlationId: string,
  ): Promise<Failure | null> {
    let role: string | null;
    try {
      role = await store.findMembershipRole(organizationId, membershipId);
    } catch {
      return storageUnavailable(correlationId);
    }
    if (role === null) return validationFields("membershipId", correlationId);
    return null;
  }

  return {
    async recordActivity(context, command) {
      const correlationId = context.correlationId || "-";
      const parsed = recordActivityCommandSchema.safeParse(command);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Record activity command is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireStaff(context);
      if (denial) return denial;

      const digest = commandDigest("ledger.recordActivity", input);
      const replay = await checkIdempotentReplay(
        store,
        context.organizationId,
        input.idempotencyKey,
        "ledger.recordActivity",
        digest,
        recordedActivitySchema,
        correlationId,
      );
      if (replay) return replay;

      const membershipIds = [
        ...new Set(
          input.contributions
            .map((draft) => draft.membershipId)
            .filter((value): value is string => value !== null),
        ),
      ];
      for (const membershipId of membershipIds) {
        const invalid = await membershipLiveness(
          context.organizationId,
          membershipId,
          correlationId,
        );
        if (invalid) return invalid;
      }

      const timestamp = now().toISOString();
      const activity: ActivityRecord = {
        schemaVersion: 1,
        organizationId: context.organizationId,
        activityId: ids(),
        revision: 1,
        kind: input.kind,
        localDate: input.localDate,
        datePrecision: input.datePrecision,
        beneficiaryReference: input.beneficiaryReference,
        origin: input.origin,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const contributions: ContributionRecord[] = input.contributions.map(
        (draft) => ({
          schemaVersion: 1,
          organizationId: context.organizationId,
          contributionId: ids(),
          activityId: activity.activityId,
          revision: 1,
          membershipId: draft.membershipId,
          durationMinutes: draft.durationMinutes,
          status: "pending",
          origin: input.origin,
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      const result = { activity, contributions };
      const occurredAt = now();

      return finalizeMutation(store, context, {
        commandType: "ledger.recordActivity",
        idempotencyKey: input.idempotencyKey,
        digest,
        result,
        resultSchema: recordedActivitySchema,
        anchors: membershipIds,
        writes: [
          { kind: "insert-activity", record: activity },
          ...contributions.map(
            (record) => ({ kind: "insert-contribution", record }) as const,
          ),
        ],
        audit: [
          {
            aggregateType: "activity",
            aggregateId: activity.activityId,
            aggregateRevision: 1,
            action: "record",
            actor: context.actor,
            correlationId,
            reason: input.origin.kind === "staff" ? input.origin.reason : null,
            before: null,
            after: activity,
            occurredAt,
          },
          ...contributions.map((record) => ({
            aggregateType: "contribution" as const,
            aggregateId: record.contributionId,
            aggregateRevision: 1,
            action: "record",
            actor: context.actor,
            correlationId,
            reason: null,
            before: null,
            after: record,
            occurredAt,
          })),
        ],
        events: [],
      });
    },

    async reviseActivity(context, command) {
      const correlationId = context.correlationId || "-";
      const parsed = reviseActivityCommandSchema.safeParse(command);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Revise activity command is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireStaff(context);
      if (denial) return denial;

      const digest = commandDigest("ledger.reviseActivity", input);
      const replay = await checkIdempotentReplay(
        store,
        context.organizationId,
        input.idempotencyKey,
        "ledger.reviseActivity",
        digest,
        activityRecordSchema,
        correlationId,
      );
      if (replay) return replay;

      let existing: ActivityRecord | null;
      try {
        existing = await store.getActivity(
          context.organizationId,
          input.activityId,
        );
      } catch {
        return storageUnavailable(correlationId);
      }
      if (!existing)
        return failure("NOT_FOUND", "Activity not found", correlationId);
      if (existing.revision !== input.expectedRevision)
        return failure(
          "CONFLICT",
          "Aggregate revision does not match the stored record",
          correlationId,
        );

      const next: ActivityRecord = {
        ...existing,
        kind: input.kind,
        localDate: input.localDate,
        datePrecision: input.datePrecision,
        beneficiaryReference: input.beneficiaryReference,
        revision: existing.revision + 1,
        updatedAt: now().toISOString(),
      };

      return finalizeMutation(store, context, {
        commandType: "ledger.reviseActivity",
        idempotencyKey: input.idempotencyKey,
        digest,
        result: next,
        resultSchema: activityRecordSchema,
        anchors: [],
        writes: [
          {
            kind: "update-activity",
            record: next,
            expectedRevision: input.expectedRevision,
          },
        ],
        audit: [
          {
            aggregateType: "activity",
            aggregateId: next.activityId,
            aggregateRevision: next.revision,
            action: "revise",
            actor: context.actor,
            correlationId,
            reason: input.reason,
            before: existing,
            after: next,
            occurredAt: now(),
          },
        ],
        events: [],
      });
    },

    async addContribution(context, command) {
      const correlationId = context.correlationId || "-";
      const parsed = addContributionCommandSchema.safeParse(command);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Add contribution command is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireStaff(context);
      if (denial) return denial;

      const digest = commandDigest("ledger.addContribution", input);
      const replay = await checkIdempotentReplay(
        store,
        context.organizationId,
        input.idempotencyKey,
        "ledger.addContribution",
        digest,
        contributionRecordSchema,
        correlationId,
      );
      if (replay) return replay;

      let activity: ActivityRecord | null;
      try {
        activity = await store.getActivity(
          context.organizationId,
          input.activityId,
        );
      } catch {
        return storageUnavailable(correlationId);
      }
      if (!activity)
        return failure("NOT_FOUND", "Activity not found", correlationId);

      if (input.membershipId !== null) {
        const invalid = await membershipLiveness(
          context.organizationId,
          input.membershipId,
          correlationId,
        );
        if (invalid) return invalid;
      }

      const timestamp = now().toISOString();
      const record: ContributionRecord = {
        schemaVersion: 1,
        organizationId: context.organizationId,
        contributionId: ids(),
        activityId: input.activityId,
        revision: 1,
        membershipId: input.membershipId,
        durationMinutes: input.durationMinutes,
        status: "pending",
        origin: input.origin,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      return finalizeMutation(store, context, {
        commandType: "ledger.addContribution",
        idempotencyKey: input.idempotencyKey,
        digest,
        result: record,
        resultSchema: contributionRecordSchema,
        anchors: record.membershipId ? [record.membershipId] : [],
        writes: [{ kind: "insert-contribution", record }],
        audit: [
          {
            aggregateType: "contribution",
            aggregateId: record.contributionId,
            aggregateRevision: 1,
            action: "add",
            actor: context.actor,
            correlationId,
            reason: null,
            before: null,
            after: record,
            occurredAt: now(),
          },
        ],
        events: [],
      });
    },

    async transitionContribution(context, command) {
      const correlationId = context.correlationId || "-";
      const parsed = contributionTransitionSchema.safeParse(command);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Contribution transition command is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireStaff(context);
      if (denial) return denial;

      const digest = commandDigest("ledger.transitionContribution", input);
      const replay = await checkIdempotentReplay(
        store,
        context.organizationId,
        input.idempotencyKey,
        "ledger.transitionContribution",
        digest,
        contributionRecordSchema,
        correlationId,
      );
      if (replay) return replay;

      let existing: ContributionRecord | null;
      try {
        existing = await store.getContribution(
          context.organizationId,
          input.contributionId,
        );
      } catch {
        return storageUnavailable(correlationId);
      }
      if (!existing)
        return failure("NOT_FOUND", "Contribution not found", correlationId);
      if (existing.revision !== input.expectedRevision)
        return failure(
          "CONFLICT",
          "Aggregate revision does not match the stored record",
          correlationId,
        );

      const action = input.action;
      const rule = contributionTransitionRules[action];
      if (!(rule.from as readonly string[]).includes(existing.status))
        return failure(
          "CONFLICT",
          "The transition is not permitted from the current status",
          correlationId,
        );

      if (action === "approve") {
        // Approval needs the recorded membership and duration, but not a live
        // member row: later membership removal preserves approved minutes.
        if (existing.membershipId === null)
          return validationFields("membershipId", correlationId);
        if (existing.durationMinutes === null)
          return failure(
            "VALIDATION",
            "Approved contributions need a resolved volunteer and duration",
            correlationId,
          );
      }

      const next: ContributionRecord = {
        ...existing,
        durationMinutes:
          input.action === "correct"
            ? input.durationMinutes
            : existing.durationMinutes,
        status: rule.to ?? existing.status,
        revision: existing.revision + 1,
        updatedAt: now().toISOString(),
      };

      const reason = "reason" in input ? input.reason : null;
      const ledgerReason =
        input.action === "approve"
          ? ("approved" as const)
          : input.action === "correct" && existing.status === "approved"
            ? ("corrected" as const)
            : input.action === "supersede" && existing.status === "approved"
              ? ("superseded" as const)
              : null;

      return finalizeMutation(store, context, {
        commandType: "ledger.transitionContribution",
        idempotencyKey: input.idempotencyKey,
        digest,
        result: next,
        resultSchema: contributionRecordSchema,
        anchors: [],
        writes: [
          {
            kind: "update-contribution",
            record: next,
            expectedRevision: input.expectedRevision,
            expectedStatus: existing.status,
          },
        ],
        audit: [
          {
            aggregateType: "contribution",
            aggregateId: next.contributionId,
            aggregateRevision: next.revision,
            action,
            actor: context.actor,
            correlationId,
            reason,
            before: existing,
            after: next,
            occurredAt: now(),
          },
        ],
        events: ledgerReason
          ? [
              {
                id: domainEventId(
                  context.organizationId,
                  "ledger.changed",
                  next.contributionId,
                  next.revision,
                ),
                type: "ledger.changed",
                aggregateId: next.contributionId,
                aggregateRevision: next.revision,
                payload: {
                  contributionId: next.contributionId,
                  reason: ledgerReason,
                },
                actor: context.actor,
                correlationId,
                occurredAt: now(),
              },
            ]
          : [],
      });
    },

    async getActivity(context, activityId) {
      const correlationId = context.correlationId || "-";
      const denial = await requireStaff(context);
      if (denial) return denial;

      let activity: ActivityRecord | null;
      let contributions: ContributionRecord[];
      try {
        activity = await store.getActivity(context.organizationId, activityId);
        contributions = activity
          ? await store.listActivityContributions(
              context.organizationId,
              activityId,
            )
          : [];
      } catch {
        return storageUnavailable(correlationId);
      }
      if (!activity)
        return failure("NOT_FOUND", "Activity not found", correlationId);
      return { ok: true, value: { activity, contributions } };
    },

    async listContributions(context, query) {
      const correlationId = context.correlationId || "-";
      if (context.actor.kind === "system")
        return forbiddenSystem(correlationId);
      const parsed = contributionListQuerySchema.safeParse(query);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Contribution list query is invalid",
          correlationId,
        );
      const input = parsed.data;

      const staff = await authorization.require(context, "review:write");
      let membershipId: string | undefined;
      if (staff.ok) {
        membershipId = undefined;
      } else {
        const submit = await authorization.require(context, "source:submit");
        if (!submit.ok)
          return failure(
            "FORBIDDEN",
            "Role does not grant ledger access",
            correlationId,
          );
        membershipId = context.actor.membershipId;
      }

      try {
        const records = await store.listContributions(context.organizationId, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(membershipId !== undefined ? { membershipId } : {}),
          limit: input.limit ?? 50,
        });
        return { ok: true, value: records };
      } catch {
        return storageUnavailable(correlationId);
      }
    },

    async summarize(context) {
      const correlationId = context.correlationId || "-";
      if (context.actor.kind === "system")
        return forbiddenSystem(correlationId);
      const required = await authorization.require(context, "report:read");
      if (!required.ok) return required;
      try {
        return {
          ok: true,
          value: await store.summarize(context.organizationId),
        };
      } catch {
        return storageUnavailable(correlationId);
      }
    },
  };
}
