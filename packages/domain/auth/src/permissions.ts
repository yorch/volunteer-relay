import { roleSchema } from "@relay/contracts";

// The contract defines the role vocabulary and the permission set; this module
// only maps one to the other so no lane redefines either.
export type ContractRole = (typeof roleSchema.options)[number];

export const permissions = [
  "source:submit",
  "review:write",
  "need:manage",
  "report:read",
] as const;

export type Permission = (typeof permissions)[number];

const allPermissions: readonly Permission[] = permissions;

export const rolePermissions: Readonly<
  Record<ContractRole, readonly Permission[]>
> = {
  owner: allPermissions,
  coordinator: allPermissions,
  volunteer: ["source:submit"],
  "report-reader": ["report:read"],
};

export function isContractRole(value: string): value is ContractRole {
  return (roleSchema.options as readonly string[]).includes(value);
}

export function isPermission(value: string): value is Permission {
  return (permissions as readonly string[]).includes(value);
}

// An unrecognized role grants nothing: authorization fails closed.
export function roleGrants(role: string, permission: Permission): boolean {
  return isContractRole(role) && rolePermissions[role].includes(permission);
}
