import { member, organization, user } from "./schema/index.ts";
import type { Database } from "./types.ts";

// Synthetic tenants only. Organization and membership ids line up with
// fixtures/sources.json so later slices share one invented population.
// No account row, password hash or credential template is created here: known
// passwords belong to an explicit demo profile, not to this seed.
const organizations = [
  {
    id: "tidepath",
    name: "Tidepath Mutual Aid",
    slug: "tidepath",
  },
  {
    id: "harbor",
    name: "Harbor Neighbour Network",
    slug: "harbor",
  },
];

const users = [
  { id: "user-mira", name: "Mira", email: "mira@example.invalid" },
  { id: "user-sol", name: "Sol", email: "sol@example.invalid" },
  { id: "user-luz", name: "Luz", email: "luz@example.invalid" },
  { id: "user-nico", name: "Nico", email: "nico@example.invalid" },
  // Multi-membership staff account: owner in one tenant, report reader in the
  // other, to exercise role differences across the same person.
  { id: "user-rae", name: "Rae", email: "rae@example.invalid" },
];

const memberships = [
  {
    id: "tidepath-mira",
    organizationId: "tidepath",
    userId: "user-mira",
    role: "volunteer",
  },
  {
    id: "tidepath-sol",
    organizationId: "tidepath",
    userId: "user-sol",
    role: "volunteer",
  },
  {
    id: "tidepath-luz",
    organizationId: "tidepath",
    userId: "user-luz",
    role: "volunteer",
  },
  {
    id: "harbor-nico",
    organizationId: "harbor",
    userId: "user-nico",
    role: "volunteer",
  },
  {
    id: "tidepath-rae",
    organizationId: "tidepath",
    userId: "user-rae",
    role: "owner",
  },
  {
    id: "harbor-rae",
    organizationId: "harbor",
    userId: "user-rae",
    role: "report-reader",
  },
];

export interface SeedSummary {
  organizations: number;
  users: number;
  memberships: number;
}

// Idempotent: every insert is keyed by its explicit id and skips existing rows,
// so a repeated run adds nothing. Memberships carry the tenant-scoped key.
export async function seedOrganizations(db: Database): Promise<SeedSummary> {
  return db.transaction(async (tx) => {
    const insertedOrganizations = await tx
      .insert(organization)
      .values(organizations)
      .onConflictDoNothing()
      .returning({ id: organization.id });
    const insertedUsers = await tx
      .insert(user)
      .values(users)
      .onConflictDoNothing()
      .returning({ id: user.id });
    const insertedMemberships = await tx
      .insert(member)
      .values(memberships)
      .onConflictDoNothing()
      .returning({ id: member.id });

    return {
      organizations: insertedOrganizations.length,
      users: insertedUsers.length,
      memberships: insertedMemberships.length,
    };
  });
}
