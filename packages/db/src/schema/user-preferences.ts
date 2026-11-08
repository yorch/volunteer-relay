import { foreignKey, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { member, user } from "./auth.ts";

// Per-user hint naming the organization the user last selected. It is a
// convenience for pre-selecting an organization when a new session starts and
// never an authority: readers re-resolve live membership before using it.
//
// The row is keyed by the user (one hint per person), but its tenant relation
// is the organization-scoped membership key (organization_id, user_id). The
// composite foreign key means a hint can only name an organization the user is
// a member of, and removing the membership or deleting the organization (which
// cascades to member) removes the hint instead of leaving it dangling.
export const userLastOrganization = pgTable(
  "user_last_organization",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "user_last_organization_membership_fk",
      columns: [table.organizationId, table.userId],
      foreignColumns: [member.organizationId, member.userId],
    }).onDelete("cascade"),
  ],
);
