import { randomUUID } from "node:crypto";
import type { Result } from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

export interface ModelBudgetRequest {
  organizationId: string;
  requestId: string;
  model: string;
  windowStart: string;
  windowEnd: string;
  limitMicroUsd: number;
  inputTokenLimit: number;
  outputTokenLimit: number;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
}
export interface ModelBudgetReservation {
  reservationId: string;
  reservedMicroUsd: number;
}
const success = <T>(value: T): Result<T> => ({ ok: true, value });
function failure(
  code: "VALIDATION" | "CONFLICT" | "DEPENDENCY_UNAVAILABLE",
  message: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      correlationId: "model-budget",
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}
class Stop extends Error {
  readonly code: "VALIDATION" | "CONFLICT";
  constructor(code: "VALIDATION" | "CONFLICT", message: string) {
    super(message);
    this.code = code;
  }
}
const MAX_INT = 2147483647;
function validInt(n: number, max = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(n) && n >= 0 && n <= max;
}
function cost(
  input: number,
  output: number,
  inputRate: number,
  outputRate: number,
): number {
  const total =
    (BigInt(input) * BigInt(inputRate) +
      BigInt(output) * BigInt(outputRate) +
      999999n) /
    1000000n;
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Stop("VALIDATION", "Budget amount too large");
  return Number(total);
}
function period(request: ModelBudgetRequest, now: Date): boolean {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return (
    request.windowStart === start.toISOString() &&
    request.windowEnd === end.toISOString()
  );
}
function safe(request: ModelBudgetRequest, now: Date): boolean {
  return (
    typeof request.organizationId === "string" &&
    request.organizationId.length > 0 &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.model === "string" &&
    request.model.length > 0 &&
    period(request, now) &&
    validInt(request.limitMicroUsd) &&
    request.limitMicroUsd > 0 &&
    validInt(request.inputTokenLimit, MAX_INT) &&
    request.inputTokenLimit > 0 &&
    validInt(request.outputTokenLimit, MAX_INT) &&
    request.outputTokenLimit > 0 &&
    validInt(request.inputMicroUsdPerMillion, 2_000_000_000_000) &&
    validInt(request.outputMicroUsdPerMillion, 2_000_000_000_000) &&
    (request.inputMicroUsdPerMillion > 0 ||
      request.outputMicroUsdPerMillion > 0)
  );
}
const fail = (e: unknown): Result<never> =>
  e instanceof Stop
    ? failure(e.code, e.message)
    : failure("DEPENDENCY_UNAVAILABLE", "Model budget storage unavailable");

/** Internal trusted-server API. Reservations cover the entire deployment, not one tenant. */
export function createModelBudgetRepository(
  db: Database,
  { now = () => new Date() }: { now?: () => Date } = {},
) {
  async function lock(tx: Pick<Database, "execute">) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('relay:model-budget:global',0))`,
    );
  }
  return {
    async reserveModelBudget(
      request: ModelBudgetRequest,
    ): Promise<Result<ModelBudgetReservation>> {
      const time = now();
      if (!safe(request, time))
        return failure("VALIDATION", "Invalid model budget configuration");
      try {
        const amount = cost(
          request.inputTokenLimit,
          request.outputTokenLimit,
          request.inputMicroUsdPerMillion,
          request.outputMicroUsdPerMillion,
        );
        return await db.transaction(async (tx) => {
          await lock(tx);
          const existing = await tx.execute(
            sql`select r.*, w.limit_micro_usd from model_budget_reservation r join model_budget_window w on w.window_start=r.window_start where r.organization_id=${request.organizationId} and r.request_id=${request.requestId} for update of r`,
          );
          const row = existing.rows[0];
          if (row) {
            const same =
              Number(row.limit_micro_usd) === request.limitMicroUsd &&
              row.model === request.model &&
              new Date(row.window_start as string).toISOString() ===
                request.windowStart &&
              row.input_token_limit === request.inputTokenLimit &&
              row.output_token_limit === request.outputTokenLimit &&
              Number(row.input_rate) === request.inputMicroUsdPerMillion &&
              Number(row.output_rate) === request.outputMicroUsdPerMillion;
            if (!same || row.status === "cancelled")
              throw new Stop("CONFLICT", "Budget request already used");
            return success({
              reservationId: row.id as string,
              reservedMicroUsd: Number(row.reserved_micro_usd),
            });
          }
          const window = await tx.execute(
            sql`select * from model_budget_window where window_start=${new Date(request.windowStart)} for update`,
          );
          const w = window.rows[0];
          if (w) {
            if (
              Number(w.limit_micro_usd) !== request.limitMicroUsd ||
              new Date(w.window_end as string).toISOString() !==
                request.windowEnd
            )
              throw new Stop("CONFLICT", "Budget window configuration changed");
          } else
            await tx.execute(
              sql`insert into model_budget_window(window_start,window_end,limit_micro_usd,created_at) values (${new Date(request.windowStart)},${new Date(request.windowEnd)},${request.limitMicroUsd},${time})`,
            );
          const spent = await tx.execute(
            sql`select coalesce(sum(case when status='settled' then actual_micro_usd when status in ('reserved','sent') then reserved_micro_usd else 0 end),0)::text as total from model_budget_reservation where window_start=${new Date(request.windowStart)}`,
          );
          if (
            BigInt(spent.rows[0]?.total as string) + BigInt(amount) >
            BigInt(request.limitMicroUsd)
          )
            throw new Stop("CONFLICT", "Monthly model budget exhausted");
          const id = randomUUID();
          await tx.execute(
            sql`insert into model_budget_reservation(id,organization_id,request_id,window_start,model,input_token_limit,output_token_limit,input_rate,output_rate,reserved_micro_usd,status,created_at,updated_at) values (${id},${request.organizationId},${request.requestId},${new Date(request.windowStart)},${request.model},${request.inputTokenLimit},${request.outputTokenLimit},${request.inputMicroUsdPerMillion},${request.outputMicroUsdPerMillion},${amount},'reserved',${time},${time})`,
          );
          return success({ reservationId: id, reservedMicroUsd: amount });
        });
      } catch (e) {
        return fail(e);
      }
    },
    async markModelBudgetSent(reservationId: string): Promise<Result<void>> {
      try {
        return await db.transaction(async (tx) => {
          await lock(tx);
          const rows = await tx.execute(
            sql`update model_budget_reservation set status='sent',updated_at=${now()} where id=${reservationId} and status='reserved' returning id`,
          );
          if (!rows.rows.length)
            throw new Stop("CONFLICT", "Reservation unavailable for sending");
          return success(undefined);
        });
      } catch (e) {
        return fail(e);
      }
    },
    async cancelModelBudget(reservationId: string): Promise<Result<void>> {
      try {
        return await db.transaction(async (tx) => {
          await lock(tx);
          const rows = await tx.execute(
            sql`update model_budget_reservation set status='cancelled',updated_at=${now()} where id=${reservationId} and status='reserved' returning id`,
          );
          if (!rows.rows.length)
            throw new Stop("CONFLICT", "Reservation cannot be cancelled");
          return success(undefined);
        });
      } catch (e) {
        return fail(e);
      }
    },
    async settleModelBudget(
      reservationId: string,
      usage: { inputTokens: number; outputTokens: number },
    ): Promise<Result<{ actualMicroUsd: number }>> {
      if (
        !validInt(usage.inputTokens, MAX_INT) ||
        !validInt(usage.outputTokens, MAX_INT)
      )
        return failure("VALIDATION", "Invalid provider usage");
      try {
        return await db.transaction(async (tx) => {
          await lock(tx);
          const rows = await tx.execute(
            sql`select * from model_budget_reservation where id=${reservationId} for update`,
          );
          const row = rows.rows[0];
          if (!row) throw new Stop("CONFLICT", "Reservation unavailable");
          if (row.status === "settled") {
            if (
              row.actual_input !== usage.inputTokens ||
              row.actual_output !== usage.outputTokens
            )
              throw new Stop(
                "CONFLICT",
                "Reservation already settled with different usage",
              );
            return success({ actualMicroUsd: Number(row.actual_micro_usd) });
          }
          if (row.status !== "sent")
            throw new Stop("CONFLICT", "Reservation was not sent");
          const actual = cost(
            usage.inputTokens,
            usage.outputTokens,
            Number(row.input_rate),
            Number(row.output_rate),
          );
          await tx.execute(
            sql`update model_budget_reservation set status='settled',actual_input=${usage.inputTokens},actual_output=${usage.outputTokens},actual_micro_usd=${actual},updated_at=${now()} where id=${reservationId}`,
          );
          return success({ actualMicroUsd: actual });
        });
      } catch (e) {
        return fail(e);
      }
    },
  };
}
