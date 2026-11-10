import { randomUUID } from "node:crypto";
import {
  automationPolicySchema,
  OPERATOR_ORGANIZATION_PAGE_SIZE,
  type OperatorAssignOwnerCommand,
  type OperatorCreateOrganizationCommand,
  type OperatorCreateOrganizationResult,
  type OperatorMemberRoleCommand,
  type OperatorOrganizationDetail,
  type OperatorOrganizationList,
  type OperatorOrganizationQuery,
  type OperatorOwner,
  type OperatorRenameOrganizationCommand,
  type OperatorRole,
  operatorAssignOwnerCommandSchema,
  operatorCreateOrganizationCommandSchema,
  operatorMemberRoleCommandSchema,
  operatorOrganizationQuerySchema,
  operatorRenameOrganizationCommandSchema,
  type Result,
} from "@relay/contracts";
import { databaseErrorConstraint } from "@relay/db";
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
  action:
    | "member.role"
    | "member.add"
    | "organization.create"
    | "organization.update";
  correlationId: string;
  before: unknown;
  after: unknown;
  actor: OperatorIdentity;
}

/** One transactional unit of work. Implemented over SQL in `store.ts`. */
export interface OperatorTransaction {
  /** Creates the organization and its first owner through the shared helper. */
  provision(input: {
    name: string;
    slug: string;
    timezone: string;
    ownerEmail: string;
    correlationId: string;
  }): Promise<
    Result<{ organizationId: string; membershipId: string; userId: string }>
  >;
  /** False when the organization does not exist. */
  lockOrganization(organizationId: string): Promise<boolean>;
  /** True when this user already belongs to the organization. */
  hasMembership(input: {
    organizationId: string;
    userId: string;
  }): Promise<boolean>;
  /** Rename under the name lock, excluding this organization from the check. */
  rename(input: {
    organizationId: string;
    name: string;
    slug: string;
    expectedName: string;
    expectedSlug: string;
  }): Promise<Result<void>>;
  /** Verified credential account for a possible owner assignment. */
  accessAccount(email: string): Promise<{ userId: string } | null>;
  /** Adds an owner membership for an account outside the organization. */
  addOwnerMembership(input: {
    organizationId: string;
    userId: string;
    membershipId: string;
  }): Promise<void>;
  /** Forces the account to prove the mailbox again: no session, no password. */
  revokeAccountAccess(userId: string): Promise<void>;
  /** Current owner memberships of the organization. */
  ownerMemberships(organizationId: string): Promise<string[]>;
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
  /** Same-transaction platform trail for a mutation. */
  recordPlatformEvent(event: PlatformEvent): Promise<void>;
}

export interface PlatformEvent {
  operatorUserId: string;
  action: string;
  targetOrganizationId: string | null;
  query: string | null;
  correlationId: string;
}

export interface OperatorStore {
  transaction<T>(run: (tx: OperatorTransaction) => Promise<T>): Promise<T>;
  /** Records a read before it happens; a failure must fail the read closed. */
  recordPlatformEvent(input: PlatformEvent): Promise<void>;
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
  list(input: {
    query: OperatorOrganizationQuery;
    actor: OperatorIdentity;
    correlationId: string;
  }): Promise<Result<OperatorOrganizationList>>;
  detail(input: {
    organizationId: string;
    actor: OperatorIdentity;
    correlationId: string;
  }): Promise<Result<OperatorOrganizationDetail>>;
  createOrganization(input: {
    actor: OperatorIdentity;
    command: OperatorCreateOrganizationCommand;
    correlationId: string;
  }): Promise<Result<OperatorCreateOrganizationResult>>;
  assignOwner(input: {
    actor: OperatorIdentity;
    command: OperatorAssignOwnerCommand;
    correlationId: string;
  }): Promise<Result<void>>;
  renameOrganization(input: {
    actor: OperatorIdentity;
    command: OperatorRenameOrganizationCommand;
    correlationId: string;
  }): Promise<Result<void>>;
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
    async list({ query, actor, correlationId }) {
      const parsed = operatorOrganizationQuerySchema.safeParse(query);
      if (!parsed.success) return operatorFailure("VALIDATION", "-");
      const term = parsed.data.q?.toLowerCase();
      const after = parsed.data.cursor
        ? decodeCursor(parsed.data.cursor)
        : null;
      if (parsed.data.cursor && !after)
        return operatorFailure("VALIDATION", "-");
      try {
        // A read is recorded before it happens: an operator must never see an
        // organization without leaving a trace, so a failed record fails the
        // read closed.
        await store.recordPlatformEvent({
          operatorUserId: actor.userId,
          action: "operator.list",
          targetOrganizationId: null,
          query: parsed.data.q ?? null,
          correlationId,
        });
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
        logFailure("list", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },

    async detail({ organizationId, actor, correlationId }) {
      if (
        typeof organizationId !== "string" ||
        organizationId.length === 0 ||
        organizationId.length > 128
      )
        return operatorFailure("VALIDATION", correlationId);
      try {
        await store.recordPlatformEvent({
          operatorUserId: actor.userId,
          action: "operator.detail",
          targetOrganizationId: organizationId,
          query: null,
          correlationId,
        });
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
      try {
        return await store.transaction(async (tx) => {
          // Refused before the write, not after: the operator must never be the
          // owner of anything, even for the duration of a rolled-back insert.
          const existing = await tx.accessAccount(
            parsed.data.ownerEmail.trim().toLowerCase(),
          );
          if (existing?.userId === actor.userId)
            return operatorFailure("FORBIDDEN", correlationId);
          // One shared creation path with scripts/provision-organization.ts.
          const created = await tx.provision({
            name: parsed.data.name,
            slug: parsed.data.slug,
            timezone: parsed.data.timezone,
            ownerEmail: parsed.data.ownerEmail,
            correlationId,
          });
          if (!created.ok) return created;
          const { organizationId, membershipId, userId } = created.value;
          if (userId === actor.userId)
            return operatorFailure("FORBIDDEN", correlationId);
          await tx.recordAudit({
            organizationId,
            membershipId,
            correlationId,
            action: "organization.create",
            before: null,
            after: { name: parsed.data.name, slug: parsed.data.slug },
            actor,
          });
          await tx.recordAudit({
            organizationId,
            membershipId,
            correlationId,
            action: "member.add",
            before: null,
            after: { role: "owner", userId },
            actor,
          });
          await tx.recordPlatformEvent({
            operatorUserId: actor.userId,
            action: "organization.create",
            targetOrganizationId: organizationId,
            query: null,
            correlationId,
          });
          return ok({ organizationId });
        });
      } catch (error) {
        if (postgresCode(error) === "23505")
          return operatorFailure("CONFLICT", correlationId);
        logFailure("createOrganization", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },

    async assignOwner({ actor, command, correlationId }) {
      const parsed = operatorAssignOwnerCommandSchema.safeParse(command);
      if (!parsed.success) return operatorFailure("VALIDATION", correlationId);
      const email = parsed.data.email.trim().toLowerCase();
      try {
        return await store.transaction(async (tx) => {
          const { organizationId } = parsed.data;
          if (!(await tx.lockOrganization(organizationId)))
            return operatorFailure("NOT_FOUND", correlationId);
          if (await tx.hasMembership({ organizationId, userId: actor.userId }))
            return operatorFailure("FORBIDDEN", correlationId);
          // Recovery only: an organization that still has an owner goes through
          // ordinary ownership changes, which notify and conflict on staleness.
          if ((await tx.ownerMemberships(organizationId)).length > 0)
            return operatorFailure("CONFLICT", correlationId);
          const account = await tx.accessAccount(email);
          if (!account) return operatorFailure("VALIDATION", correlationId);
          if (account.userId === actor.userId)
            return operatorFailure("FORBIDDEN", correlationId);
          const membershipId = newId();
          await tx.addOwnerMembership({
            organizationId,
            userId: account.userId,
            membershipId,
          });
          // The account may have been registered by someone else while the
          // address was unverified: verification alone does not rotate a
          // password or end sessions. Nothing signs in again without the
          // mailbox.
          await tx.revokeAccountAccess(account.userId);
          await tx.recordAudit({
            organizationId,
            membershipId,
            correlationId,
            action: "member.add",
            before: null,
            after: { role: "owner", userId: account.userId, recovery: true },
            actor,
          });
          await tx.recordPlatformEvent({
            operatorUserId: actor.userId,
            action: "member.add",
            targetOrganizationId: organizationId,
            query: null,
            correlationId,
          });
          return ok(undefined);
        });
      } catch (error) {
        if (postgresCode(error) === "23505")
          return operatorFailure("CONFLICT", correlationId);
        logFailure("assignOwner", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },

    async renameOrganization({ actor, command, correlationId }) {
      const parsed = operatorRenameOrganizationCommandSchema.safeParse(command);
      if (!parsed.success) return operatorFailure("VALIDATION", correlationId);
      try {
        return await store.transaction(async (tx) => {
          const { organizationId } = parsed.data;
          if (await tx.hasMembership({ organizationId, userId: actor.userId }))
            return operatorFailure("FORBIDDEN", correlationId);
          const renamed = await tx.rename({
            organizationId,
            name: parsed.data.name,
            slug: parsed.data.slug,
            expectedName: parsed.data.expectedName,
            expectedSlug: parsed.data.expectedSlug,
          });
          if (!renamed.ok) return renamed;
          await tx.recordAudit({
            organizationId,
            membershipId: organizationId,
            correlationId,
            action: "organization.update",
            before: {
              name: parsed.data.expectedName,
              slug: parsed.data.expectedSlug,
            },
            after: { name: parsed.data.name, slug: parsed.data.slug },
            actor,
          });
          await tx.recordPlatformEvent({
            operatorUserId: actor.userId,
            action: "organization.update",
            targetOrganizationId: organizationId,
            query: null,
            correlationId,
          });
          return ok(undefined);
        });
      } catch (error) {
        if (postgresCode(error) === "23505")
          return operatorFailure("CONFLICT", correlationId);
        logFailure("renameOrganization", correlationId);
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
            action: "member.role",
            before: { role: target.role },
            after: { role },
            actor,
          });
          await tx.recordPlatformEvent({
            operatorUserId: actor.userId,
            action: "member.role",
            targetOrganizationId: organizationId,
            query: null,
            correlationId,
          });
          return ok(undefined);
        });
      } catch (error) {
        // The database invariant is the backstop for this path; surface it as a
        // conflict so an operator is told to refresh rather than to retry later.
        if (databaseErrorConstraint(error) === "organization_last_owner_check")
          return operatorFailure("CONFLICT", correlationId);
        logFailure("setMemberRole", correlationId);
        return operatorFailure("DEPENDENCY_UNAVAILABLE", correlationId);
      }
    },
  };
}
