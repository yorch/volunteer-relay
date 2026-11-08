import { describe, expect, it } from "vitest";
import { organizationAppPath } from "./follow-through.ts";

describe("organizationAppPath", () => {
  it("adds the org selector hint to workspace paths", () => {
    expect(organizationAppPath("/workspace/needs", "org_1")).toBe(
      "/workspace/needs?org=org_1",
    );
  });
  it("leaves the path unchanged for unsafe ids or paths", () => {
    expect(organizationAppPath("/workspace/needs", "a&b=c")).toBe(
      "/workspace/needs",
    );
    expect(organizationAppPath("/workspace/needs", "")).toBe(
      "/workspace/needs",
    );
    expect(organizationAppPath("https://evil.test/", "org_1")).toBe(
      "https://evil.test/",
    );
    expect(organizationAppPath("/workspace/a?x=1", "org_1")).toBe(
      "/workspace/a?x=1",
    );
  });
});
