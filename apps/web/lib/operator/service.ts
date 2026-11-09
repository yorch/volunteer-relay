import { randomUUID } from "node:crypto";
import {
  automationPolicySchema,
  OPERATOR_ORGANIZATION_PAGE_SIZE,
  type OperatorCreateOrganizationCommand,
  type OperatorCreateOrganizationResult,
  type OperatorMemberRoleCommand,
  type OperatorOrganizationDetail,
  type OperatorOrganizationList,
  type OperatorOrganizationQuery,
  type OperatorOwner,
  type OperatorRole,
  operatorCreateOrganizationCommandSchema,
  operatorMemberRoleCommandSchema,
  operatorOrganizationQuerySchema,
  type Result,
} from "@relay/contracts";
import type { OperatorIdentity } from "./accounts.ts";

type Code =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "DEPENDENCY_UNAVAILABLE";

const messages: Record<Code, string> = {
  FORBIDDEN: "This action is not permitted",
  NOT_FOUND: "Resource was not found",
  VALIDATION: "Check the submitted fields",
  CONFLICT: "The record changed. Refresh and try again",
  DEPENDENCY_UNAVAILABLE: "The service is temporarily unavailable",
};

export function operatorFailure(
  code: Code,
  correlationId: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: messages[code],
      correlationId,
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/**
 * Logs a bounded failure without SQL parameters or addresses, so a persistent
 * bug such as an audit constraint violation is visible instead of looking like
 * a permanent outage.
 */
function logFailure(operation: string, correlationId: string) {
  console.warn("operator.failure", { operation, correlationId });
}

/** Postgres SQLSTATE from an error or its cause chain (drizzle wraps errors). */
export function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Escapes LIKE metacharacters so a search term is matched literally. */
export function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

/**
 * Keyset cursor for the organization list: the (lower(name), organization id)
 * of the last row of the previous page. Opaque to the client and validated on
 * the way in, so a crafted cursor cannot become a query.
 */
export function encodeCursor(name: string, organizationId: string): string {
  return Buffer.from(JSON.stringify([name, organizationId]), "utf8").toString(
    "base64url",
  );
}
export function decodeCursor(value: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      parsed[0].length <= 200 &&
      parsed[1].length <= 128
    )
      return [parsed[0], parsed[1]];
    return null;
  } catch {
    return null;
  }
}

export interface OperatorAuditEntry {
  organizationId: string;
  membershipId: string;
  correlationId: string;
  before: unknown;
  after: unknown;
  actor: OperatorIdentity;
}

/** One transactional unit of work. Implemented over SQL in `store.ts`. */
export interface OperatorTransaction {
  verifiedAccount(email: string): Promise<{ userId: string } | null>;
  hasPassword(userId: string): Promise<boolean>;
  /** Serializes same-name creation; lower(name) has no unique index. */
  lockOrganizationName(name: string): Promise<void>;
  organizationTaken(input: { name: string; slug: string }): Promise<boolean>;
  insertOrganization(input: {
    organizationId: string;
    name: string;
    slug: string;
  }): Promise<void>;
  insertMembership(input: {
    membershipId: string;
    organizationId: string;
    userId: string;
    role: "owner";
  }): Promise<void>;
  insertSettings(input: {
    organizationId: string;
    settings: {
      revision: number;
      timezone: string;
      automationPolicy: string;
      policyVersion: string;
      routing: Record<string, never>;
      fallbackMembershipId: null;
      ackMinutes: number;
      retentionDays: number;
    };
  }): Promise<void>;
  /** False when the organization does not exist. */
  lockOrganization(organizationId: string): Promise<boolean>;
  /** True when this user already belongs to the organization. */
  hasMembership(input: {
    organizationId: string;
    userId: string;
  }): Promise<boolean>;
  /**
   * Locks the target membership and every current owner row of the
   * organization, so the owner count a decision relies on holds until commit.
   */
  lockMemberRows(input: {
    organizationId: string;
    membershipId: string;
  }): Promise<{ membershipId: string; userId: string; role: string }[]>;
  updateRole(input: {
    organizationId: string;
    membershipId: string;
    role: OperatorRole;
  }): Promise<void>;
  recordAudit(entry: OperatorAuditEntry): Promise<void>;
}

export interface OperatorStore {
  transaction<T>(run: (tx: OperatorTransaction) => Promise<T>): Promise<T>;
  listOrganizations(input: {
    pattern: string | null;
    after: [string, string] | null;
    limit: number;
  }): Promise<{
    rows: {
      organizationId: string;
      /** The exact value Postgres ordered by, so the next page cannot skip. */
      sortName: string;
      name: string;
      slug: string;
      createdAt: string;
      members: OperatorOrganizationDetail["organization"]["members"];
      owners: OperatorOwner[];
      pendingInvitations: number;
    }[];
    hasMore: boolean;
  }>;
  getOrganization(
    organizationId: string,
    memberLimit: number,
  ): Promise<OperatorOrganizationDetail | null>;
}

export interface OperatorService {
  list(
    query: OperatorOrganizationQuery,
  ): Promise<Result<OperatorOrganizationList>>;
  detail(input: {
    organizationId: string;
    correlationId: string;
  }): Promise<Result<OperatorOrganizationDetail>>;
  createOrganization(input: {
    actor: OperatorIdentity;
    command: OperatorCreateOrganizationCommand;
    correlationId: string;
  }): Promise<Result<OperatorCreateOrganizationResult>>;
  setMemberRole(input: {
    actor: OperatorIdentity;
    command: OperatorMemberRoleCommand;
    correlationId: string;
  }): Promise<Result<void>>;
}

/**
 * Cross-organization administration decisions. This is NOT tenant context: no
 * method accepts a session, cookie or asserted organization as authority, and
 * every mutation names its target explicitly and writes its audit row inside
 * the same transaction as the change.
 */
export function createOperatorService(
  store: OperatorStore,
  { newId = () => randomUUID() }: { newId?: () => string } = {},
): OperatorService {
  return {
    async list(query) {
      const parsed = operatorOrganizationQuerySchema.safeParse(query);
      if (!parsed.success) return operatorFailure("VALIDATION", "-");
      const term = parsed.data.q?.toLowerCase();
      const after = parsed.data.cursor
        ? decodeCursor(parsed.data.cursor)
        : null;
      if (parsed.data.cursor && !after)
        return operatorFailure("VALIDATION", "-");
      try {
        const page = await store.listOrganizations({
          pattern: term ? `%${escapeLike(term)}%` : null,
          after,
          limit: OPERATOR_ORGANIZATION_PAGE_SIZE,
        });
        const last = page.hasMore ? page.rows.at(-1) : undefined;
        return ok({
          organizations: page.rows.map((row) => ({
            organizationId: row.organizationId,
            name: row.name,
            slug: row.slug,
            createdAt: row.createdAt,
            members: row.members,
            owners: row.owners,
            ownersTruncated: row.members.owner > row.owners.length,
            pendingInvitations: row.pendingInvitations,
          })),
          nextCursor: last
            ? encodeCursor(last.name.toLowerCase(), last.organizationId)
            : null,
        });
      } catch {
        logFailure("list", "-");
        return operatorFailure("DEPENDENCY_UNAVAILABLE", "-");
      }
    },

    async detail({ organizationId, correlationId }) {
      if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        organizationId.length > 128
      )
        return operatorFailure("VALIDATION", correlationId);
      try {
        const detail = await store.getOrganization(organizationId, 200);
        return detail === null
          ? operatorFailure("NOT_FOUND", correlationId)
          : ok(detail);
      } catch {
        logFailure("detail", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },

    async createOrganization({ actor, command, correlationId }) {
      const parsed = operatorCreateOrganizationCommandSchema.safeParse(command);
      if (!parsed.success) return operatorFailure("VALIDATION", correlationId);
      const { name, slug, timezone } = parsed.data;
      const email = parsed.data.ownerEmail.trim().toLowerCase();
      const organizationId = newId();
      const membershipId = newId();
      // Kept in step with scripts/provision-organization.ts and the defaults in
      // packages/db/src/repositories/follow-through.ts. A shared creation helper
      // (including the advisory lock) is proposed as a B-owned follow-up in the
      // ADR rather than duplicated silently in a second place.
      const settings = {
        revision: 1,
        timezone,
        automationPolicy: automationPolicySchema.parse("review-all"),
        policyVersion: "1",
        routing: {} as Record<string, never>,
        fallbackMembershipId: null,
        ackMinutes: 60,
        retentionDays: 365,
      };
      try {
        return await store.transaction(async (tx) => {
          const account = await tx.verifiedAccount(email);
          // One neutral refusal for "no such account", "unverified" and "no
          // password": the operator learns nothing about the address.
          if (!account || !(await tx.hasPassword(account.userId)))
            return operatorFailure("VALIDATION", correlationId);
          // A global capability must not be convertible into a tenant role:
          // the console never makes the operator an owner of anything.
          if (account.userId === actor.userId)
            return operatorFailure("FORBIDDEN", correlationId);
          await tx.lockOrganizationName(name);
          if (await tx.organizationTaken({ name, slug }))
            return operatorFailure("CONFLICT", correlationId);
          await tx.insertOrganization({ organizationId, name, slug });
          await tx.insertMembership({
            membershipId,
            organizationId,
            userId: account.userId,
            role: "owner",
          });
          await tx.insertSettings({ organizationId, settings });
          // The existing audit vocabulary only (no migration in this slice): the
          // initial ownership grant, attributed to the operator, with the
          // creation flag in `after`. A dedicated organization.create action is
          // proposed as a B-owned follow-up in the ADR.
          await tx.recordAudit({
            organizationId,
            membershipId,
            correlationId,
            before: null,
            after: {
              role: "owner",
              organizationCreated: true,
              organizationId,
              userId: account.userId,
            },
            actor,
          });
          return ok({ organizationId });
        });
      } catch (error) {
        // A concurrent creation with the same slug reaches the unique index
        // rather than the advisory lock; that is a conflict, not an outage.
        if (postgresCode(error) === "23505")
          return operatorFailure("CONFLICT", correlationId);
        logFailure("createOrganization", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },

    async setMemberRole({ actor, command, correlationId }) {
      const parsed = operatorMemberRoleCommandSchema.safeParse(command);
      if (!parsed.success) return operatorFailure("VALIDATION", correlationId);
      const { organizationId, membershipId, role, expectedRole } = parsed.data;
      try {
        return await store.transaction(async (tx) => {
          if (!(await tx.lockOrganization(organizationId)))
            return operatorFailure("NOT_FOUND", correlationId);
          // Separation of duties: an operator who belongs to this organization
          // administers it through the workspace, not from the global console.
          if (await tx.hasMembership({ organizationId, userId: actor.userId }))
            return operatorFailure("FORBIDDEN", correlationId);
          const locked = await tx.lockMemberRows({
            organizationId,
            membershipId,
          });
          const target = locked.find(
            (row) => row.membershipId === membershipId,
          );
          if (!target) return operatorFailure("NOT_FOUND", correlationId);
          // The console administers other people's ownership, never the
          // operator's own tenant role.
          if (target.userId === actor.userId)
            return operatorFailure("FORBIDDEN", correlationId);
          if (target.role !== expectedRole)
            return operatorFailure("CONFLICT", correlationId);
          const owners = locked.filter((row) => row.role === "owner").length;
          if (role === "owner") {
            // Only a promotion; an existing owner is not re-granted.
            if (target.role === "owner")
              return operatorFailure("VALIDATION", correlationId);
          } else {
            // Only a revocation of ownership, and never the last owner.
            if (target.role !== "owner")
              return operatorFailure("VALIDATION", correlationId);
            if (owners <= 1) return operatorFailure("CONFLICT", correlationId);
          }
          await tx.updateRole({ organizationId, membershipId, role });
          await tx.recordAudit({
            organizationId,
            membershipId,
            correlationId,
            before: { role: target.role },
            after: { role },
            actor,
          });
          return ok(undefined);
        });
      } catch {
        logFailure("setMemberRole", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },
  };
}
