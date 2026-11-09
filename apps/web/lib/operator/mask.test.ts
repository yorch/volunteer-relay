import { describe, expect, it } from "vitest";
import { maskEmail } from "./mask.ts";

describe("maskEmail", () => {
  it("keeps one local character and the domain", () => {
    expect(maskEmail("owner@example.org")).toBe("o•••@example.org");
    expect(maskEmail("a@sub.example.org")).toBe("a•••@sub.example.org");
  });

  it("masks anything that is not a usable address entirely", () => {
    for (const value of ["", "@example.org", "owner", "owner@", "owner@nodot"])
      expect(maskEmail(value)).toBe("•••");
  });
});
