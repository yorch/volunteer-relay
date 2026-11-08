import { randomUUID } from "node:crypto";
import type { AuthorizationService } from "@relay/contracts";
import type { LastOrganizationStore } from "@relay/db";

export interface LastOrganizationHintDependencies {
  store: LastOrganizationStore;
  authorization: AuthorizationService;
}

/**
 * Best-effort last-used organization hint. It only pre-selects an organization
 * for a session that has none; it is never authority. A stored hint is used
 * only after the verified user's live membership resolves through the same
 * authorization service as an explicit organization switch, and a hint whose
 * membership no longer resolves is cleared. No failure here ever fails sign-in
 * or an organization switch.
 */
export function createLastOrganizationHints({
  store,
  authorization,
}: LastOrganizationHintDependencies) {
  return {
    async remember(userId: string, organizationId: string): Promise<void> {
      try {
        await store.remember({ userId, organizationId });
      } catch {
        // Best effort: a missing or concurrently removed membership (foreign
        // key) or an unavailable database leaves the previous hint in place.
      }
    },

    // Returns the hinted organization only when live membership resolves.
    async resolve(userId: string): Promise<string | null> {
      let organizationId: string | null;
      try {
        organizationId = await store.read(userId);
      } catch {
        return null;
      }
      if (!organizationId) return null;
      try {
        const resolved = await authorization.resolve(
          userId,
          organizationId,
          randomUUID(),
        );
        if (resolved.ok) return organizationId;
        // A denial is durable; an unavailable dependency is not, so the hint
        // survives for the next sign-in.
        if (!resolved.error.retryable)
          await store.forget({ userId, organizationId });
      } catch {
        // Treated as no hint.
      }
      return null;
    },
  };
}

export type LastOrganizationHints = ReturnType<
  typeof createLastOrganizationHints
>;
