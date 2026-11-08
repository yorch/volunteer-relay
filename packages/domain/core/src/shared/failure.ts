import type { ApiError, Result } from "@relay/contracts";

export type Failure = Extract<Result<never>, { ok: false }>;

export function failure(
  code: ApiError["error"]["code"],
  message: string,
  correlationId: string,
  retryable = false,
  fields?: Record<string, string[]>,
): Failure {
  return {
    ok: false,
    error: {
      code,
      message,
      correlationId,
      retryable,
      ...(fields ? { fields } : {}),
    },
  };
}
