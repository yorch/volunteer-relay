import { randomUUID } from "node:crypto";
import type { Result, TenantContext } from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

type Action = "member.role" | "member.remove" | "member.invite";
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function fail(
  context: TenantContext,
  code: "FORBIDDEN" | "VALIDATION" | "NOT_FOUND" | "DEPENDENCY_UNAVAILABLE",
  message: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      correlationId: context.correlationId || "-",
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}
export function createAdministrationAuditRepository(db: Database) {
  return {
    async beginOperation(
      context: TenantContext,
      input: { action: Action; targetId: string },
    ): Promise<Result<{ operationId: string }>> {
      if (
        !input ||
        !["member.role", "member.remove", "member.invite"].includes(
          input.action,
        ) ||
        typeof input.targetId !== "string" ||
        !input.targetId ||
        input.targetId.length > 200 ||
        (input.action === "member.invite" &&
          !/^[a-f0-9]{64}$/.test(input.targetId))
      )
        return fail(context, "VALIDATION", "Invalid administrative operation");
      try {
        return await db.transaction(async (tx) => {
          if (context.actor.kind !== "user")
            return fail(context, "FORBIDDEN", "Owner authority required");
          const owner = await tx.execute(
            sql`select id from member where organization_id=${context.organizationId} and id=${context.actor.membershipId} and user_id=${context.actor.userId} and role='owner' for share`,
          );
          if (!owner.rows.length)
            return fail(context, "FORBIDDEN", "Owner authority required");
          if (input.action !== "member.invite") {
            const target = await tx.execute(
              sql`select id from member where organization_id=${context.organizationId} and id=${input.targetId} for share`,
            );
            if (!target.rows.length)
              return fail(context, "NOT_FOUND", "Membership not found");
          }
          const id = randomUUID();
          await tx.execute(
            sql`insert into organization_audit_event(organization_id,operation_id,phase,action,target_id,actor,correlation_id,occurred_at) values (${context.organizationId},${id},'requested',${input.action},${input.targetId},${JSON.stringify(context.actor)}::jsonb,${context.correlationId},now())`,
          );
          return ok({ operationId: id });
        });
      } catch {
        return fail(
          context,
          "DEPENDENCY_UNAVAILABLE",
          "Administration audit unavailable",
        );
      }
    },
    async finishOperation(
      organizationId: string,
      operationId: string,
      outcome: "succeeded" | "failed",
    ): Promise<void> {
      if (
        !organizationId ||
        !operationId ||
        !(outcome === "succeeded" || outcome === "failed")
      )
        throw new Error("Invalid administrative completion");
      try {
        await db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([organizationId, operationId])},0))`,
          );
          const rows = await tx.execute(
            sql`select * from organization_audit_event where organization_id=${organizationId} and operation_id=${operationId} and phase='requested'`,
          );
          const row = rows.rows[0];
          if (!row) throw new Error("Administrative request unavailable");
          const terminal = await tx.execute(
            sql`select phase from organization_audit_event where organization_id=${organizationId} and operation_id=${operationId} and phase in ('succeeded','failed')`,
          );
          if (terminal.rows[0]) {
            if (terminal.rows[0].phase === outcome) return;
            throw new Error("Administrative completion already recorded");
          }
          await tx.execute(
            sql`insert into organization_audit_event(organization_id,operation_id,phase,action,target_id,actor,correlation_id,occurred_at) values (${organizationId},${operationId},${outcome},${row.action as string},${row.target_id as string},${JSON.stringify(row.actor)}::jsonb,${row.correlation_id as string},now())`,
          );
        });
      } catch {
        throw new Error("Administration audit completion unavailable");
      }
    },
  };
}
