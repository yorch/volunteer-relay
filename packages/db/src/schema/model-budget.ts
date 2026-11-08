import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";

const time = (name: string) => timestamp(name, { withTimezone: true });
export const modelBudgetWindow = pgTable(
  "model_budget_window",
  {
    windowStart: time("window_start").primaryKey(),
    windowEnd: time("window_end").notNull(),
    limitMicroUsd: bigint("limit_micro_usd", { mode: "number" }).notNull(),
    createdAt: time("created_at").notNull(),
  },
  (t) => [check("budget_window_limit_check", sql`${t.limitMicroUsd}>0`)],
);
export const modelBudgetReservation = pgTable(
  "model_budget_reservation",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    requestId: text("request_id").notNull(),
    windowStart: time("window_start")
      .notNull()
      .references(() => modelBudgetWindow.windowStart),
    model: text("model").notNull(),
    inputTokenLimit: integer("input_token_limit").notNull(),
    outputTokenLimit: integer("output_token_limit").notNull(),
    inputRate: bigint("input_rate", { mode: "number" }).notNull(),
    outputRate: bigint("output_rate", { mode: "number" }).notNull(),
    reservedMicroUsd: bigint("reserved_micro_usd", {
      mode: "number",
    }).notNull(),
    status: text("status").notNull(),
    actualInput: integer("actual_input"),
    actualOutput: integer("actual_output"),
    actualMicroUsd: bigint("actual_micro_usd", { mode: "number" }),
    createdAt: time("created_at").notNull(),
    updatedAt: time("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.organizationId, t.requestId),
    check(
      "budget_reservation_status_check",
      sql`${t.status} in ('reserved','sent','settled','cancelled')`,
    ),
    check(
      "budget_reservation_values_check",
      sql`${t.inputTokenLimit}>=0 and ${t.outputTokenLimit}>=0 and ${t.inputRate}>=0 and ${t.outputRate}>=0 and ${t.reservedMicroUsd}>=0`,
    ),
    check(
      "budget_reservation_actual_check",
      sql`(${t.status}='settled' and ${t.actualInput} is not null and ${t.actualOutput} is not null and ${t.actualMicroUsd} is not null and ${t.actualInput}>=0 and ${t.actualOutput}>=0 and ${t.actualMicroUsd}>=0) or (${t.status}<>'settled' and ${t.actualInput} is null and ${t.actualOutput} is null and ${t.actualMicroUsd} is null)`,
    ),
  ],
);
