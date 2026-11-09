import { expect, it } from "vitest";
import {
  apiErrorSchema,
  errorCodeHttpStatus,
  errorCodeSchema,
} from "./index.ts";

// Independently authored oracle: the frozen code-to-status table.
const expected = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  EMAIL_NOT_VERIFIED: 403,
  INVITATION_EXPIRED: 410,
  NOT_AVAILABLE: 404,
};

it("keeps every original code and adds the invitation-acceptance codes", () => {
  expect([...errorCodeSchema.options].sort()).toEqual(
    Object.keys(expected).sort(),
  );
  expect(errorCodeHttpStatus).toEqual(expected);
});

it("accepts the additive codes in the strict error envelope", () => {
  for (const code of [
    "EMAIL_NOT_VERIFIED",
    "INVITATION_EXPIRED",
    "NOT_AVAILABLE",
  ])
    expect(
      apiErrorSchema.safeParse({
        error: { code, message: "m", correlationId: "c", retryable: false },
      }).success,
    ).toBe(true);
  expect(
    apiErrorSchema.safeParse({
      error: {
        code: "INVITATION_NOT_FOUND",
        message: "m",
        correlationId: "c",
        retryable: false,
      },
    }).success,
  ).toBe(false);
});
