import type { AuthorizationService } from "@relay/contracts";
import { createMembershipReader, type Database } from "@relay/db";
import { createAuthorizationService } from "@relay/domain/auth";

export interface TenantAuthorizationDependencies {
  db: Database;
}

/**
 * Server-side composition of the tenant authorization port. Callers must pass a
 * user id taken from a verified Better Auth session, never a request body, and
 * the organization id they are acting in; the service re-reads live membership
 * and role on every decision.
 */
export function createTenantAuthorization({
  db,
}: TenantAuthorizationDependencies): AuthorizationService {
  return createAuthorizationService({
    memberships: createMembershipReader(db),
  });
}
