import type {
  AuthorizationService,
  NeedRecord,
  NeedService,
  TenantContext,
} from "@relay/contracts";
import {
  createNeedCommandSchema,
  needListQuerySchema,
  needRecordSchema,
  needTransitionRules,
  needTransitionSchema,
} from "@relay/contracts";
import type { DomainStore, OutboxEntry } from "../domain-store.ts";
import { commandDigest, domainEventId } from "../shared/events.ts";
import { type Failure, failure } from "../shared/failure.ts";
import {
  checkIdempotentReplay,
  finalizeMutation,
  storageUnavailable,
} from "../shared/mutation.ts";

export interface NeedServiceDependencies {
  authorization: AuthorizationService;
  store: DomainStore;
  now?: () => Date;
  ids?: () => string;
}

/**
 * Human-authorized need lifecycle (ADR 0009). need:manage operates needs; only
 * the current owner acknowledges. Every mutation, including creation, emits
 * need.changed with the resulting status and provisional flag.
 */
export function createNeedService({
  authorization,
  store,
  now = () => new Date(),
  ids = () => crypto.randomUUID(),
}: NeedServiceDependencies): NeedService {
  async function requireManager(
    context: TenantContext,
  ): Promise<Failure | null> {
    const correlationId = context.correlationId || "-";
    if (context.actor.kind === "system")
      return failure(
        "FORBIDDEN",
        "System actor cannot manage needs",
        correlationId,
      );
    const required = await authorization.require(context, "need:manage");
    if (!required.ok) return required;
    return null;
  }

  function needChangedEvent(
    context: TenantContext,
    need: NeedRecord,
    occurredAt: Date,
  ): OutboxEntry {
    const correlationId = context.correlationId || "-";
    return {
      id: domainEventId(
        context.organizationId,
        "need.changed",
        need.needId,
        need.revision,
      ),
      type: "need.changed",
      aggregateId: need.needId,
      aggregateRevision: need.revision,
      payload: {
        needId: need.needId,
        status: need.status,
        provisional: need.provisional,
      },
      actor: context.actor,
      correlationId,
      occurredAt,
    };
  }

  return {
    async create(context, command) {
      const correlationId = context.correlationId || "-";
      const parsed = createNeedCommandSchema.safeParse(command);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Create need command is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireManager(context);
      if (denial) return denial;

      const digest = commandDigest("need.create", input);
      const replay = await checkIdempotentReplay(
        store,
        context.organizationId,
        input.idempotencyKey,
        "need.create",
        digest,
        needRecordSchema,
        correlationId,
      );
      if (replay) return replay;

      const timestamp = now().toISOString();
      const record: NeedRecord = {
        schemaVersion: 1,
        organizationId: context.organizationId,
        needId: ids(),
        revision: 1,
        category: input.category,
        urgency: input.urgency,
        summary: input.summary,
        provisional: input.provisional,
        status: "new",
        ownerMembershipId: null,
        dueAt: input.dueAt,
        acknowledgeBy: input.acknowledgeBy,
        acknowledgedAt: null,
        acknowledgedByMembershipId: null,
        resolvedAt: null,
        resolution: null,
        origin: input.origin,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const occurredAt = now();

      return finalizeMutation(store, context, {
        commandType: "need.create",
        idempotencyKey: input.idempotencyKey,
        digest,
        result: record,
        resultSchema: needRecordSchema,
        anchors: [],
        writes: [{ kind: "insert-need", record }],
        audit: [
          {
            aggregateType: "need",
            aggregateId: record.needId,
            aggregateRevision: 1,
            action: "create",
            actor: context.actor,
            correlationId,
            reason: input.origin.kind === "staff" ? input.origin.reason : null,
            before: null,
            after: record,
            occurredAt,
          },
        ],
        events: [needChangedEvent(context, record, occurredAt)],
      });
    },

    async transition(context, command) {
      const correlationId = context.correlationId || "-";
      const parsed = needTransitionSchema.safeParse(command);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Need transition command is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireManager(context);
      if (denial) return denial;

      const digest = commandDigest("need.transition", input);
      const replay = await checkIdempotentReplay(
        store,
        context.organizationId,
        input.idempotencyKey,
        "need.transition",
        digest,
        needRecordSchema,
        correlationId,
      );
      if (replay) return replay;

      let existing: NeedRecord | null;
      try {
        existing = await store.getNeed(context.organizationId, input.needId);
      } catch {
        return storageUnavailable(correlationId);
      }
      if (!existing)
        return failure("NOT_FOUND", "Need not found", correlationId);
      if (existing.revision !== input.expectedRevision)
        return failure(
          "CONFLICT",
          "Aggregate revision does not match the stored record",
          correlationId,
        );

      const rule = needTransitionRules[input.action];
      if (!(rule.from as readonly string[]).includes(existing.status))
        return failure(
          "CONFLICT",
          "The transition is not permitted from the current status",
          correlationId,
        );

      const anchors: string[] = [];
      let next: NeedRecord;
      const timestamp = now().toISOString();
      const base = {
        ...existing,
        status: rule.to,
        revision: existing.revision + 1,
        updatedAt: timestamp,
      };

      switch (input.action) {
        case "assign": {
          // The new owner must be a live owner/coordinator membership.
          let role: string | null;
          try {
            role = await store.findMembershipRole(
              context.organizationId,
              input.ownerMembershipId,
            );
          } catch {
            return storageUnavailable(correlationId);
          }
          if (role !== "owner" && role !== "coordinator")
            return failure(
              "VALIDATION",
              "Need owner must be a current owner or coordinator of this organization",
              correlationId,
              false,
              {
                ownerMembershipId: [
                  "must be a current owner or coordinator membership",
                ],
              },
            );
          anchors.push(input.ownerMembershipId);
          next = {
            ...base,
            ownerMembershipId: input.ownerMembershipId,
            acknowledgeBy: input.acknowledgeBy,
            acknowledgedAt: null,
            acknowledgedByMembershipId: null,
          };
          break;
        }
        case "acknowledge": {
          // Only the current owner membership acknowledges.
          if (
            context.actor.kind !== "user" ||
            context.actor.membershipId !== existing.ownerMembershipId
          )
            return failure(
              "FORBIDDEN",
              "Only the need owner can acknowledge it",
              correlationId,
            );
          if (context.actor.kind === "user")
            anchors.push(context.actor.membershipId);
          next = {
            ...base,
            acknowledgedAt: timestamp,
            acknowledgedByMembershipId:
              context.actor.kind === "user" ? context.actor.membershipId : null,
          };
          break;
        }
        case "resolve":
          next = {
            ...base,
            resolvedAt: timestamp,
            resolution: input.resolution,
          };
          break;
        case "cancel":
          next = { ...base };
          break;
        case "reopen":
          next = {
            ...base,
            ownerMembershipId: null,
            acknowledgeBy: null,
            acknowledgedAt: null,
            acknowledgedByMembershipId: null,
            resolvedAt: null,
            resolution: null,
          };
          break;
      }

      const occurredAt = now();
      return finalizeMutation(store, context, {
        commandType: "need.transition",
        idempotencyKey: input.idempotencyKey,
        digest,
        result: next,
        resultSchema: needRecordSchema,
        anchors,
        writes: [
          {
            kind: "update-need",
            record: next,
            expectedRevision: input.expectedRevision,
            expectedStatus: existing.status,
          },
        ],
        audit: [
          {
            aggregateType: "need",
            aggregateId: next.needId,
            aggregateRevision: next.revision,
            action: input.action,
            actor: context.actor,
            correlationId,
            reason: "reason" in input ? input.reason : null,
            before: existing,
            after: next,
            occurredAt,
          },
        ],
        events: [needChangedEvent(context, next, occurredAt)],
      });
    },

    async get(context, needId) {
      const correlationId = context.correlationId || "-";
      const denial = await requireManager(context);
      if (denial) return denial;
      try {
        const record = await store.getNeed(context.organizationId, needId);
        if (!record)
          return failure("NOT_FOUND", "Need not found", correlationId);
        return { ok: true, value: record };
      } catch {
        return storageUnavailable(correlationId);
      }
    },

    async list(context, query) {
      const correlationId = context.correlationId || "-";
      const parsed = needListQuerySchema.safeParse(query);
      if (!parsed.success)
        return failure(
          "VALIDATION",
          "Need list query is invalid",
          correlationId,
        );
      const input = parsed.data;

      const denial = await requireManager(context);
      if (denial) return denial;
      try {
        const records = await store.listNeeds(context.organizationId, {
          ...(input.status !== undefined ? { status: input.status } : {}),
          limit: input.limit ?? 50,
        });
        return { ok: true, value: records };
      } catch {
        return storageUnavailable(correlationId);
      }
    },
  };
}
