import { randomUUID } from "node:crypto";
import {
  automationPolicySchema,
  operatorCreateOrganizationCommandSchema,
  type Result,
} from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

type Executor = Pick<Database, "execute">["execute"];

export interface ProvisionedOrganization {
  organizationId: string;
  membershipId: string;
  userId: string;
}

const MESSAGES = {
  VALIDATION: "A verified credential account is required",
  CONFLICT: "Organization name or slug already exists",
  DEPENDENCY_UNAVAILABLE: "Provisioning failed; check database state before retrying",
} as const;

function fail(
  code: keyof typeof MESSAGES,
  correlationId: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: MESSAGES[code],
      correlationId,
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}

/** Postgres SQLSTATE from an error or its cause chain (drizzle wraps errors). */
export function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Constraint name from a Postgres error, when the driver reports one. */
export function databaseErrorConstraint(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object") return undefined;
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string") return constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * The one way an organization with its first owner comes into existence.
 *
 * Callers pass their own transaction executor, so the console can write its
 * audit rows and the CLI can commit just this change in the same transaction.
 * Every failure is a bounded Result rather than a thrown error, so both callers
 * can map a taken name to a conflict instead of an outage. The advisory lock is
 * keyed on the name because `lower(name)` has no unique index; the slug has one
 * and is reported as a conflict too.
 */
export async function provisionOrganization(
  execute: Executor,
  input: {
    name: string;
    slug: string;
    timezone: string;
    ownerEmail: string;
  },
  {
    correlationId,
    newId = randomUUID,
  }: { correlationId: string; newId?: () => string } = { correlationId: "-" },
): Promise<Result<ProvisionedOrganization>> {
  const parsed = operatorCreateOrganizationCommandSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", correlationId);
  const { name, slug, timezone } = parsed.data;
  const email = parsed.data.ownerEmail.trim().toLowerCase();
  const organizationId = newId();
  const membershipId = newId();
  // Kept in step with the defaults in ./follow-through.ts; the values are
  // validated against the canonical contract rather than restated as SQL.
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
    const account = (
      await execute(
        sql`select id from "user" where lower(email)=${email} and email_verified=true for share`,
      )
    ).rows[0];
    const userId = typeof account?.id === "string" ? account.id : "";
    const credential =
      userId === ""
        ? []
        : (
            await execute(
              sql`select id from account where user_id=${userId} and provider_id='credential' and password is not null and length(password)>0 for share`,
            )
          ).rows;
    // One neutral refusal for "no such account", "unverified" and "no
    // password": the caller learns nothing about the address.
    if (userId === "" || credential.length === 0)
      return fail("VALIDATION", correlationId);
    await execute(
      sql`select pg_advisory_xact_lock(hashtextextended(lower(${name}),0))`,
    );
    const existing = (
      await execute(
        sql`select 1 from organization where slug=${slug} or lower(name)=lower(${name})`,
      )
    ).rows;
    if (existing.length > 0) return fail("CONFLICT", correlationId);
    await execute(
      sql`insert into organization(id,name,slug,created_at) values (${organizationId},${name},${slug},now())`,
    );
    await execute(
      sql`insert into member(id,organization_id,user_id,role,created_at) values (${membershipId},${organizationId},${userId},'owner',now())`,
    );
    await execute(
      sql`insert into organization_settings(organization_id,revision,timezone,automation_policy,policy_version,routing,fallback_membership_id,ack_minutes,retention_days) values (${organizationId},${settings.revision},${settings.timezone},${settings.automationPolicy},${settings.policyVersion},${JSON.stringify(settings.routing)}::jsonb,${settings.fallbackMembershipId},${settings.ackMinutes},${settings.retentionDays})`,
    );
    return { ok: true, value: { organizationId, membershipId, userId } };
  } catch (error) {
    // A concurrent creation with the same slug reaches the unique index rather
    // than the advisory lock: that is a conflict, not an outage.
    if (
      databaseErrorCode(error) === "23505" &&
      (databaseErrorConstraint(error) ?? "").includes("slug")
    )
      return fail("CONFLICT", correlationId);
    return fail("DEPENDENCY_UNAVAILABLE", correlationId);
  }
}
