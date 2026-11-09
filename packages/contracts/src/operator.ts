import { z } from "zod";
import { roleSchema } from "./roles.ts";

// Platform-operator contracts (P8-01). Additive: no existing schema, version or
// role vocabulary changes. `operator` is deliberately NOT a contract role — the
// capability comes from deployment configuration bound to a user account, so it
// can never be invited, granted through member administration, or persisted in
// member.role. See docs/adr/0012-platform-operator-console.md.

const id = z.string().min(1).max(128);
const instant = z.iso.datetime({ offset: true });

/** An allowlisted operator account. Both values must match exactly. */
export const operatorAccountSchema = z
  .object({
    userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    email: z.email().max(254),
  })
  .strict();
export type OperatorAccount = z.infer<typeof operatorAccountSchema>;

/**
 * Parses the deployment's operator allowlist. Entries are `userId:email`,
 * comma-separated. The user id is immutable and the email is an independent
 * second factor for configuration mistakes: an address alone is not ownership
 * of an account, because anyone can register an unclaimed address and wait for
 * the real person to verify it. Deliberately reserved domains are refused so a
 * demo address can never become an operator.
 */
export const operatorAccountsSchema = z
  .string()
  .max(4096)
  .transform((value, ctx) => {
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const accounts: OperatorAccount[] = [];
    const seen = new Set<string>();
    const emails = new Set<string>();
    for (const entry of entries) {
      const separator = entry.indexOf(":");
      const parsed =
        separator > 0
          ? operatorAccountSchema.safeParse({
              userId: entry.slice(0, separator).trim(),
              email: entry
                .slice(separator + 1)
                .trim()
                .toLowerCase(),
            })
          : null;
      if (!parsed?.success) {
        ctx.addIssue({
          code: "custom",
          message: "Operator entries must be userId:email",
        });
        return z.NEVER;
      }
      if (parsed.data.email.endsWith(".invalid")) {
        ctx.addIssue({
          code: "custom",
          message: "A reserved demonstration domain cannot be an operator",
        });
        return z.NEVER;
      }
      if (seen.has(parsed.data.userId)) {
        ctx.addIssue({
          code: "custom",
          message: "Operator accounts must be unique by user id",
        });
        return z.NEVER;
      }
      if (emails.has(parsed.data.email)) {
        ctx.addIssue({
          code: "custom",
          message: "Operator accounts must be unique by address",
        });
        return z.NEVER;
      }
      seen.add(parsed.data.userId);
      emails.add(parsed.data.email);
      accounts.push(parsed.data);
    }
    if (accounts.length > 20) {
      ctx.addIssue({
        code: "custom",
        message: "At most 20 operator accounts are configured",
      });
      return z.NEVER;
    }
    return accounts;
  });

/** Parsed allowlist; empty means the console is disabled. */
export type OperatorAccounts = z.infer<typeof operatorAccountsSchema>;
export function parseOperatorAccounts(value: string | undefined) {
  return operatorAccountsSchema.parse(value ?? "");
}

/**
 * Session proof for the console. A non-operator never reaches this shape: the
 * transport answers NOT_FOUND for every state that is not a live operator, so
 * the console's existence is not a per-account oracle.
 */
export const operatorSessionSchema = z
  .object({ operator: z.literal(true) })
  .strict();
export type OperatorSession = z.infer<typeof operatorSessionSchema>;

export const OPERATOR_ORGANIZATION_PAGE_SIZE = 50;
export const OPERATOR_OWNER_LIMIT = 20;

/**
 * An owner as an operator may see them: enough to tell two people apart, not a
 * cross-tenant address directory. The local part is masked; no endpoint returns
 * an unmasked address in this slice.
 */
export const operatorOwnerSchema = z
  .object({
    membershipId: id,
    name: z.string().min(1).max(200),
    maskedEmail: z.string().min(3).max(254),
    joinedAt: instant,
  })
  .strict();
export type OperatorOwner = z.infer<typeof operatorOwnerSchema>;

export const operatorMemberCountsSchema = z
  .object({
    owner: z.number().int().nonnegative(),
    coordinator: z.number().int().nonnegative(),
    volunteer: z.number().int().nonnegative(),
    reportReader: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type OperatorMemberCounts = z.infer<typeof operatorMemberCountsSchema>;

export const operatorOrganizationSchema = z
  .object({
    organizationId: id,
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(63),
    createdAt: instant,
    members: operatorMemberCountsSchema,
    owners: z.array(operatorOwnerSchema).max(OPERATOR_OWNER_LIMIT),
    ownersTruncated: z.boolean(),
    pendingInvitations: z.number().int().nonnegative(),
  })
  .strict();
export type OperatorOrganization = z.infer<typeof operatorOrganizationSchema>;

export const operatorOrganizationListSchema = z
  .object({
    organizations: z.array(operatorOrganizationSchema),
    nextCursor: z.string().max(1024).nullable(),
  })
  .strict();
export type OperatorOrganizationList = z.infer<
  typeof operatorOrganizationListSchema
>;

/**
 * List query. `q` matches organization name and slug only — never a member
 * address, so the console cannot be used to enumerate people. Cursor paging
 * keeps a list read bounded regardless of organization count.
 */
export const operatorOrganizationQuerySchema = z
  .object({
    q: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .refine((value) => !/[%\p{Cc}]/u.test(value), "Check the search text")
      .optional(),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,1024}$/)
      .optional(),
  })
  .strict();
export type OperatorOrganizationQuery = z.infer<
  typeof operatorOrganizationQuerySchema
>;

export const OPERATOR_MEMBER_LIMIT = 200;

/**
 * A member row of one organization, for choosing an owner. Addresses stay
 * masked for the same reason as the list view.
 */
export const operatorMemberSchema = z
  .object({
    membershipId: id,
    name: z.string().min(1).max(200),
    maskedEmail: z.string().min(3).max(254),
    role: roleSchema,
    joinedAt: instant,
  })
  .strict();
export type OperatorMember = z.infer<typeof operatorMemberSchema>;

export const operatorOrganizationDetailSchema = z
  .object({
    organization: operatorOrganizationSchema,
    members: z.array(operatorMemberSchema).max(OPERATOR_MEMBER_LIMIT),
    membersTruncated: z.boolean(),
  })
  .strict();
export type OperatorOrganizationDetail = z.infer<
  typeof operatorOrganizationDetailSchema
>;

export const operatorOrganizationDetailQuerySchema = z
  .object({ organizationId: id })
  .strict();
export type OperatorOrganizationDetailQuery = z.infer<
  typeof operatorOrganizationDetailQuerySchema
>;

/** Roles an operator may set and unset. Ownership only, never a general grant. */
export const operatorRoleSchema = z.enum(["owner", "coordinator"]);
export type OperatorRole = z.infer<typeof operatorRoleSchema>;

/**
 * Owner grant/revoke. `expectedRole` makes the command optimistic: a stale view
 * conflicts instead of overwriting a role someone else just changed, including
 * an owner an operator did not know about.
 */
export const operatorMemberRoleCommandSchema = z
  .object({
    organizationId: id,
    membershipId: id,
    role: operatorRoleSchema,
    expectedRole: roleSchema,
  })
  .strict();
export type OperatorMemberRoleCommand = z.infer<
  typeof operatorMemberRoleCommandSchema
>;

const slug = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const organizationName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\p{Cc}/u.test(value), "Check the name");
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone");

/** Organization creation from the console; mirrors the provisioning CLI rules. */
export const operatorCreateOrganizationCommandSchema = z
  .object({
    name: organizationName,
    slug,
    timezone,
    ownerEmail: z.email().max(254),
  })
  .strict();
export type OperatorCreateOrganizationCommand = z.infer<
  typeof operatorCreateOrganizationCommandSchema
>;

export const operatorCreateOrganizationResultSchema = z
  .object({ organizationId: id })
  .strict();
export type OperatorCreateOrganizationResult = z.infer<
  typeof operatorCreateOrganizationResultSchema
>;
