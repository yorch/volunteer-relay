import { describe, expect, it } from "vitest";
import { isOrganizationHintId, splitOrganizationHint } from "./org-hint.ts";

describe("organization hint", () => {
  it("accepts only id-shaped values", () => {
    for (const ok of ["org-1", "a", "org:team_2", "A".repeat(128)])
      expect(isOrganizationHintId(ok)).toBe(true);
    for (const bad of ["", "-x", "a b", "a/b", "a.b", "A".repeat(129), "é"])
      expect(isOrganizationHintId(bad)).toBe(false);
  });
  it("strips org and keeps other parameters", () => {
    expect(splitOrganizationHint("?org=org-2&tab=x")).toEqual({
      present: true,
      hint: "org-2",
      rest: "?tab=x",
    });
    expect(splitOrganizationHint("?org=org-2").rest).toBe("");
    expect(splitOrganizationHint("")).toEqual({
      present: false,
      hint: undefined,
      rest: "",
    });
  });
  it("drops a malformed hint but still reports it present", () => {
    expect(splitOrganizationHint("?org=a%2F..%2Fb")).toEqual({
      present: true,
      hint: undefined,
      rest: "",
    });
  });
});
