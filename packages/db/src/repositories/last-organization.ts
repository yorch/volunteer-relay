import { and, eq, sql } from "drizzle-orm";
import { userLastOrganization } from "../schema/index.ts";
import type { Database } from "../types.ts";

export interface LastOrganizationHint {
  userId: string;
  organizationId: string;
}

/**
 * Per-user last-used organization hint. Reading a hint grants nothing: callers
 * must re-resolve live membership for the verified user before acting on it,
 * and clear it when that resolution fails.
 */
export interface LastOrganizationStore {
  read(userId: string): Promise<string | null>;
  // Upsert; the latest committed write wins. Rejected by the membership
  // foreign key when the user is not a member of the organization.
  remember(hint: LastOrganizationHint): Promise<void>;
  // Clears only the hint that still names this organization, so a stale-hint
  // cleanup never erases a newer selection written concurrently.
  forget(hint: LastOrganizationHint): Promise<void>;
}

export function createLastOrganizationStore(
  db: Database,
): LastOrganizationStore {
  return {
    async read(userId) {
      if (!userId) return null;
      const rows = await db
        .select({ organizationId: userLastOrganization.organizationId })
        .from(userLastOrganization)
        .where(eq(userLastOrganization.userId, userId))
        .limit(1);
      return rows[0]?.organizationId ?? null;
    },

    async remember({ userId, organizationId }) {
      if (!userId || !organizationId) return;
      await db
        .insert(userLastOrganization)
        .values({ userId, organizationId })
        .onConflictDoUpdate({
          target: userLastOrganization.userId,
          set: { organizationId, updatedAt: sql`now()` },
        });
    },

    async forget({ userId, organizationId }) {
      if (!userId || !organizationId) return;
      await db
        .delete(userLastOrganization)
        .where(
          and(
            eq(userLastOrganization.userId, userId),
            eq(userLastOrganization.organizationId, organizationId),
          ),
        );
    },
  };
}
