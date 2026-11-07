import type { SourceEnvelope } from "@relay/contracts";

/**
 * Package-internal port for an extraction provider. This is deliberately not a
 * shared contract: `ExtractionService` in @relay/contracts stays the public
 * boundary, and provider output is treated as untrusted input.
 */
export interface ExtractionVersions {
  readonly model: string;
  readonly prompt: string;
  readonly policy: string;
}

export interface ExtractionProviderRequest {
  readonly source: SourceEnvelope;
  readonly versions: ExtractionVersions;
}

export interface ExtractionProvider {
  readonly name: string;
  /** Returns a model-shaped payload that the service must validate. */
  extract(request: ExtractionProviderRequest): Promise<unknown>;
}

/** Raw provider payload: only the two fields the pipeline may ever accept. */
export interface ProviderDraft {
  readonly items: readonly unknown[];
  readonly unresolved: readonly unknown[];
}

export function isProviderDraft(value: unknown): value is ProviderDraft {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { items?: unknown; unresolved?: unknown };
  return Array.isArray(candidate.items) && Array.isArray(candidate.unresolved);
}

/**
 * A provider failure with an explicit retry decision. Messages must stay free of
 * source text so bounded retry telemetry is safe to log.
 */
export class ExtractionProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ExtractionProviderError";
    this.retryable = options.retryable;
  }
}
