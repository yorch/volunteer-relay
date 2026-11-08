import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_ASSERTION_HEADER,
  organizationAssertionSchema,
} from "./index.ts";

describe("organization assertion contract", () => {
  it("names a lowercase header", () => {
    expect(ORGANIZATION_ASSERTION_HEADER).toBe("x-relay-org");
  });
  it.each([
    "org-a",
    "0b7c9a52-3f1e-4d2a-9a7e-5c1d2e3f4a5b",
    "AbC_123",
    "x".repeat(128),
  ])("accepts %s", (value) => {
    expect(organizationAssertionSchema.safeParse(value).success).toBe(true);
  });
  it.each(["", "x".repeat(129), "org-a, org-b", "org a", "org/a", "org-ä"])(
    "rejects %j",
    (value) => {
      expect(organizationAssertionSchema.safeParse(value).success).toBe(false);
    },
  );
});
