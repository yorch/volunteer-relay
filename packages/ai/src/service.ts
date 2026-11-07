import { randomUUID } from "node:crypto";
import type {
  ApiError,
  ExtractionProposal,
  ExtractionService,
  Result,
  SourceEnvelope,
  TenantContext,
} from "@relay/contracts";
import { extractionProposalSchema, proposalItemSchema } from "@relay/contracts";
import { verifyProposalEvidence } from "./evidence.ts";
import {
  type ExtractionProvider,
  ExtractionProviderError,
  type ExtractionVersions,
  isProviderDraft,
} from "./provider.ts";

type ProposalItem = ExtractionProposal["items"][number];
type ErrorCode = ApiError["error"]["code"];

export interface ExtractionAttempt {
  readonly attempt: number;
  readonly provider: string;
  readonly outcome:
    | "ok"
    | "provider_error"
    | "schema_invalid"
    | "evidence_invalid";
  readonly retryable: boolean;
  readonly code: ErrorCode | null;
}

export interface ExtractionServiceOptions {
  readonly provider: ExtractionProvider;
  /** Defaults to crypto.randomUUID; deterministic callers inject a factory. */
  readonly newRunId?: () => string;
  /** Bounded retry budget; a provider is never retried indefinitely. */
  readonly maxAttempts?: number;
  /** Observability hook. Records contain no source text. */
  readonly onAttempt?: (record: ExtractionAttempt) => void;
}

function failure(
  correlationId: string,
  code: ErrorCode,
  message: string,
  retryable: boolean,
  fields?: Record<string, string[]>,
): Result<never> {
  const error: ApiError["error"] = {
    code,
    message,
    correlationId,
    retryable,
    ...(fields === undefined ? {} : { fields }),
  };
  return { ok: false, error };
}

/**
 * Contract field names that may appear in a reported validation path. Error
 * envelopes never echo provider-controlled identifiers: a model-supplied item
 * key or evidence label can contain arbitrary source text, so only array
 * positions and known schema field names are allowed through.
 */
const SAFE_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "schemaVersion",
  "organizationId",
  "sourceId",
  "sourceRevision",
  "runId",
  "modelVersion",
  "promptVersion",
  "policyVersion",
  "items",
  "unresolved",
  "evidence",
  "field",
  "reason",
  "kind",
  "key",
  "activityKey",
  "activityKind",
  "localDate",
  "datePrecision",
  "beneficiaryReference",
  "membershipId",
  "durationMinutes",
  "category",
  "urgency",
  "summary",
  "provisional",
  "targetId",
  "expectedRevision",
  "start",
  "end",
  "quote",
  "attachmentId",
  "observation",
]);
const NUMERIC_SEGMENT = /^\d+$/;

function safeIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "root";
  return path
    .map((segment) => {
      if (typeof segment === "number") return String(segment);
      if (typeof segment !== "string") return "*";
      if (NUMERIC_SEGMENT.test(segment)) return segment;
      return SAFE_PATH_SEGMENTS.has(segment) ? segment : "*";
    })
    .join(".");
}

/**
 * Concrete ExtractionService over an untrusted provider.
 *
 * Every provider payload is schema-validated against the frozen contract and
 * evidence-verified against the exact source revision before it can become a
 * proposal. Garbage in a source message cannot widen authority: the service
 * never returns approved records, only proposals for review or policy.
 */
export function createExtractionService(
  options: ExtractionServiceOptions,
): ExtractionService {
  const maxAttempts = options.maxAttempts ?? 2;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    throw new RangeError("maxAttempts must be a positive integer");
  const newRunId = options.newRunId ?? randomUUID;
  const report = (record: ExtractionAttempt): void => {
    options.onAttempt?.(record);
  };

  return {
    async extract(
      context: TenantContext,
      source: SourceEnvelope,
      versions: ExtractionVersions,
    ): Promise<Result<ExtractionProposal>> {
      // Tenant context is resolved by the server; a parsed organization ID
      // grants no authority over another tenant's source.
      if (source.organizationId !== context.organizationId)
        return failure(
          context.correlationId,
          "FORBIDDEN",
          "Source is outside the resolved organization context.",
          false,
        );

      const runId = newRunId();
      let attempt = 0;
      while (attempt < maxAttempts) {
        attempt += 1;
        let raw: unknown;
        try {
          raw = await options.provider.extract({ source, versions });
        } catch (error) {
          const retryable =
            error instanceof ExtractionProviderError && error.retryable;
          report({
            attempt,
            provider: options.provider.name,
            outcome: "provider_error",
            retryable,
            code: "DEPENDENCY_UNAVAILABLE",
          });
          if (retryable && attempt < maxAttempts) continue;
          return failure(
            context.correlationId,
            "DEPENDENCY_UNAVAILABLE",
            "Extraction provider unavailable.",
            retryable,
          );
        }

        if (!isProviderDraft(raw)) {
          report({
            attempt,
            provider: options.provider.name,
            outcome: "schema_invalid",
            retryable: false,
            code: "VALIDATION",
          });
          return failure(
            context.correlationId,
            "VALIDATION",
            "Extraction provider output was not a proposal draft.",
            false,
            { provider: ["invalid_draft_shape"] },
          );
        }

        const items: ProposalItem[] = [];
        for (const [index, rawItem] of raw.items.entries()) {
          const parsed = proposalItemSchema.safeParse(rawItem);
          if (!parsed.success) {
            report({
              attempt,
              provider: options.provider.name,
              outcome: "schema_invalid",
              retryable: false,
              code: "VALIDATION",
            });
            return failure(
              context.correlationId,
              "VALIDATION",
              `Extraction item ${index} failed schema validation.`,
              false,
              {
                [`items[${index}]`]: parsed.error.issues.map(
                  (issue) => `${safeIssuePath(issue.path)}:${issue.code}`,
                ),
              },
            );
          }
          items.push(parsed.data);
        }

        const validated = extractionProposalSchema.safeParse({
          schemaVersion: 1,
          organizationId: source.organizationId,
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          runId,
          modelVersion: versions.model,
          promptVersion: versions.prompt,
          policyVersion: versions.policy,
          items,
          unresolved: raw.unresolved,
        });
        if (!validated.success) {
          report({
            attempt,
            provider: options.provider.name,
            outcome: "schema_invalid",
            retryable: false,
            code: "VALIDATION",
          });
          return failure(
            context.correlationId,
            "VALIDATION",
            "Extraction proposal failed contract validation.",
            false,
            {
              proposal: validated.error.issues.map(
                (issue) => `${safeIssuePath(issue.path)}:${issue.code}`,
              ),
            },
          );
        }

        const violations = verifyProposalEvidence(validated.data, source);
        if (violations.length > 0) {
          report({
            attempt,
            provider: options.provider.name,
            outcome: "evidence_invalid",
            retryable: false,
            code: "VALIDATION",
          });
          const fields: Record<string, string[]> = {};
          for (const violation of violations) {
            // Positions only: item keys and evidence labels are provider input.
            const key = `items[${violation.itemIndex}].evidence[${violation.evidenceIndex}]`;
            fields[key] = [...(fields[key] ?? []), violation.reason];
          }
          return failure(
            context.correlationId,
            "VALIDATION",
            "Extraction evidence did not match the preserved source revision.",
            false,
            fields,
          );
        }

        report({
          attempt,
          provider: options.provider.name,
          outcome: "ok",
          retryable: false,
          code: null,
        });
        return { ok: true, value: validated.data };
      }

      return failure(
        context.correlationId,
        "DEPENDENCY_UNAVAILABLE",
        "Extraction retries exhausted.",
        true,
      );
    },
  };
}
