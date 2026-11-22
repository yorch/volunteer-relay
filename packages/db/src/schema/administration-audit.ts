import type { TenantContext } from "@relay/contracts";
import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.ts";
export const organizationAuditEvent = pgTable(
  "organization_audit_event",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id),
    operationId: text("operation_id").notNull(),
    phase: text("phase").notNull(),
    action: text("action").notNull(),
    targetId: text("target_id").notNull(),
    actor: jsonb("actor").$type<TenantContext["actor"]>().notNull(),
    correlationId: text("correlation_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.operationId, t.phase] }),
    uniqueIndex("organization_audit_terminal_unique")
      .on(t.organizationId, t.operationId)
      .where(sql`${t.phase} in ('succeeded','failed')`),
    check(
      "organization_audit_phase_check",
      sql`${t.phase} in ('requested','succeeded','failed','applied')`,
    ),
    check(
      "organization_audit_action_check",
      sql`${t.action} in ('settings.update','member.role','member.remove','member.invite','member.add','organization.create','organization.update')`,
    ),
  ],
);
