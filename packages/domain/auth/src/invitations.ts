import type { ContractRole, Result } from "@relay/contracts";
import { roleSchema } from "@relay/contracts";

type Failure = Extract<Result<never>, { ok: false }>;

function invalid(message: string, field: string): Failure {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      correlationId: "-",
      retryable: false,
      fields: { [field]: [message] },
    },
  };
}

/**
 * Validates an invitation/role value against the frozen four-role vocabulary.
 * Rejects Better Auth's default aliases (admin/member), comma-separated
 * multi-role strings, padded values and anything outside roleSchema.options, so
 * an invitation cannot smuggle in an out-of-contract role.
 */
export function parseContractRole(raw: unknown): Result<ContractRole> {
  if (typeof raw !== "string")
    return invalid("Role must be a single contract role", "role");
  if (raw !== raw.trim())
    return invalid("Role must not contain surrounding whitespace", "role");
  if (raw.includes(","))
    return invalid("Role must not contain multiple roles", "role");
  const match = (roleSchema.options as readonly string[]).find(
    (role) => role === raw,
  );
  if (!match)
    return invalid("Role is not part of the contract vocabulary", "role");
  return { ok: true, value: match as ContractRole };
}

export interface InvitationCommand {
  email: string;
  role: unknown;
  organizationId: string;
}

// Shape/role validation only; authorization and tenancy are enforced by the
// caller's verified membership context and the auth plugin.
export function validateInvitationCommand(
  input: InvitationCommand,
): Result<{ email: string; role: ContractRole; organizationId: string }> {
  const role = parseContractRole(input.role);
  if (!role.ok) return role;
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!email?.includes("@")) return invalid("Email is required", "email");
  if (!input.organizationId)
    return invalid("Organization is required", "organizationId");
  return {
    ok: true,
    value: { email, role: role.value, organizationId: input.organizationId },
  };
}
