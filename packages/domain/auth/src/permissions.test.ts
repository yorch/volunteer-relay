import { describe, expect, it } from "vitest";
import {
  isContractRole,
  isPermission,
  permissions,
  roleGrants,
  rolePermissions,
} from "./permissions.ts";

describe("contract role vocabulary", () => {
  it("accepts exactly the contract roles", () => {
    for (const role of ["owner", "coordinator", "volunteer", "report-reader"])
      expect(isContractRole(role)).toBe(true);
    for (const role of ["admin", "member", "superadmin", "", "OWNER"])
      expect(isContractRole(role)).toBe(false);
  });

  it("does not grant anything through an unrecognized role", () => {
    for (const permission of permissions)
      expect(roleGrants("member", permission)).toBe(false);
  });
});

describe("permission matrix", () => {
  it("grants owner and coordinator the operational permissions", () => {
    for (const role of ["owner", "coordinator"] as const)
      for (const permission of permissions)
        expect(roleGrants(role, permission)).toBe(true);
  });

  it("keeps volunteers to source submission", () => {
    expect(roleGrants("volunteer", "source:submit")).toBe(true);
    for (const permission of [
      "review:write",
      "need:manage",
      "report:read",
    ] as const)
      expect(roleGrants("volunteer", permission)).toBe(false);
  });

  it("keeps report readers to aggregate reads", () => {
    expect(roleGrants("report-reader", "report:read")).toBe(true);
    for (const permission of [
      "source:submit",
      "review:write",
      "need:manage",
    ] as const)
      expect(roleGrants("report-reader", permission)).toBe(false);
  });

  it("only recognizes contract permissions", () => {
    for (const permission of permissions)
      expect(isPermission(permission)).toBe(true);
    for (const permission of ["review:approve", "admin", ""])
      expect(isPermission(permission)).toBe(false);
    expect(Object.keys(rolePermissions).sort()).toEqual([
      "coordinator",
      "owner",
      "report-reader",
      "volunteer",
    ]);
  });
});
