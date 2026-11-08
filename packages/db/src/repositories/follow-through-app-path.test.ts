import { safeAppPath, withOrganizationHint } from "@relay/contracts";
import * as notifications from "@relay/notifications";
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
  });
  it("keeps other query and hash and replaces a prior hint", () => {
    expect(organizationAppPath("/workspace/a?x=1", "org_1")).toBe(
      "/workspace/a?x=1&org=org_1",
    );
    expect(organizationAppPath("/workspace/a?org=old#t", "org_1")).toBe(
      "/workspace/a?org=org_1#t",
    );
  });
  it("matches the notifications implementation for every input", () => {
    const paths = ["/workspace/needs", "/workspace/a?x=1", "/x", "//e.test/"];
    const ids = ["org_1", "a&b", "", "-x", "t:1-a"];
    for (const p of paths)
      for (const id of ids)
        expect(organizationAppPath(p, id)).toBe(
          withOrganizationHint(p, id) ?? p,
        );
    expect(notifications.withOrganizationHint).toBe(withOrganizationHint);
    expect(notifications.safeAppPath).toBe(safeAppPath);
  });
});
