import type { Result, TenantContext } from "@relay/contracts";
import { domainEventSchema } from "@relay/contracts";
import type {
  AuditEntry,
  DomainMutation,
  DomainStore,
  OutboxEntry,
  Write,
} from "../domain-store.ts";
import { type Failure, failure } from "./failure.ts";

// Structural shape of the contract record schemas; the domain package does
// not depend on zod directly.
export interface ResultSchema<T> {
  safeParse(value: unknown): { success: boolean; data?: T };
}

export function storageUnavailable(correlationId: string): Failure {
  return failure(
    "DEPENDENCY_UNAVAILABLE",
    "Domain storage is unavailable",
    correlationId,
    true,
  );
}

// A stored command result is authoritative for replay only when it still
// parses under the contract record schema.
export function parseStoredResult<T>(
  result: unknown,
  resultSchema: ResultSchema<T>,
  correlationId: string,
): Result<T> {
  const parsed = resultSchema.safeParse(result);
  if (!parsed.success || parsed.data === undefined)
    return storageUnavailable(correlationId);
  return { ok: true, value: parsed.data };
}

// Returns null when the key is new and the mutation should proceed, otherwise
// the terminal result for this call.
export async function checkIdempotentReplay<T>(
  store: DomainStore,
  organizationId: string,
  idempotencyKey: string,
  commandType: string,
  digest: string,
  resultSchema: ResultSchema<T>,
  correlationId: string,
): Promise<Result<T> | null> {
  let existing: Awaited<ReturnType<DomainStore["findCommand"]>>;
  try {
    existing = await store.findCommand(organizationId, idempotencyKey);
  } catch {
    return storageUnavailable(correlationId);
  }
  if (!existing) return null;
  if (existing.commandType === commandType && existing.digest === digest)
    return parseStoredResult(existing.result, resultSchema, correlationId);
  return failure(
    "CONFLICT",
    "Idempotency key was used with a different command",
    correlationId,
  );
}

function conflictMessage(reason: string): string {
  switch (reason) {
    case "revision":
      return "Aggregate revision or status does not match the stored record";
    case "duplicate-contribution":
      return "The volunteer already has an active contribution to this activity";
    case "idempotency":
      return "Idempotency key was used with a different command";
    default:
      return "The command conflicts with stored domain state";
  }
}

function invalidTargetFailure(
  field: "membership" | "origin" | "activity",
  correlationId: string,
): Failure {
  const key =
    field === "membership"
      ? "membershipId"
      : field === "origin"
        ? "origin"
        : "activityId";
  return failure(
    "VALIDATION",
    "A referenced record is not part of this organization",
    correlationId,
    false,
    { [key]: ["is not part of this organization"] },
  );
}

// Validates built events against the wire schema, then commits the whole
// mutation atomically and maps the store outcome onto the public Result.
export async function finalizeMutation<T>(
  store: DomainStore,
  context: TenantContext,
  mutation: {
    commandType: string;
    idempotencyKey: string;
    digest: string;
    result: T;
    resultSchema: ResultSchema<T>;
    anchors: string[];
    writes: Write[];
    audit: AuditEntry[];
    events: OutboxEntry[];
  },
): Promise<Result<T>> {
  const correlationId = context.correlationId || "-";

  for (const event of mutation.events) {
    const wire = {
      schemaVersion: 1,
      eventId: event.id,
      type: event.type,
      organizationId: context.organizationId,
      aggregateId: event.aggregateId,
      aggregateRevision: event.aggregateRevision,
      payload: event.payload,
      occurredAt: event.occurredAt.toISOString(),
      correlationId: event.correlationId,
      actor: event.actor,
    };
    if (!domainEventSchema.safeParse(wire).success)
      return failure(
        "DEPENDENCY_UNAVAILABLE",
        "Domain event could not be formed",
        correlationId,
      );
  }

  const command: DomainMutation["command"] = {
    idempotencyKey: mutation.idempotencyKey,
    commandType: mutation.commandType,
    digest: mutation.digest,
    result: mutation.result,
    correlationId,
  };

  let outcome: Awaited<ReturnType<DomainStore["commit"]>>;
  try {
    outcome = await store.commit({
      organizationId: context.organizationId,
      command,
      anchors: mutation.anchors,
      writes: mutation.writes,
      audit: mutation.audit,
      events: mutation.events,
    });
  } catch {
    return storageUnavailable(correlationId);
  }

  switch (outcome.kind) {
    case "committed":
      return { ok: true, value: mutation.result };
    case "replay":
      return parseStoredResult(
        outcome.command.result,
        mutation.resultSchema,
        correlationId,
      );
    case "conflict":
      return failure(
        "CONFLICT",
        conflictMessage(outcome.reason),
        correlationId,
      );
    case "invalid-target":
      return invalidTargetFailure(outcome.field, correlationId);
  }
}
