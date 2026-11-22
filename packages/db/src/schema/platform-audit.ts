import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// The operator surface's own trail. Deliberately not tenant-scoped and with no
// foreign key to organization: a read may name no organization, and the record
// must survive an organization that is later removed. Never exposed through a
// tenant route.
export const platformAuditEvent = pgTable(
  "platform_audit_event",
  {
    id: text("id").primaryKey(),
    operatorUserId: text("operator_user_id").notNull(),
    // Bounded operation label, for example "operator.list" or "member.role".
    action: text("action").notNull(),
    targetOrganizationId: text("target_organization_id"),
    // Search text an operator supplied, when the operation had one.
    query: text("query"),
    correlationId: text("correlation_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("platform_audit_actor_idx").on(t.operatorUserId, t.occurredAt),
    index("platform_audit_organization_idx").on(
      t.targetOrganizationId,
      t.occurredAt,
    ),
  ],
);
