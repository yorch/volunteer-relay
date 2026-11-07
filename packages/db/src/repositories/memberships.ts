import { and, eq } from "drizzle-orm";
import { member, organization } from "../schema/index.ts";
import type { Database } from "../types.ts";

export interface MembershipRecord {
  membershipId: string;
  organizationId: string;
  userId: string;
  role: string;
}

export interface MembershipKey {
  userId: string;
  organizationId: string;
}

export interface OrganizationMembershipRecord extends MembershipRecord {
  organizationName: string;
  organizationSlug: string;
}

export interface MembershipReader {
  // Tenant-scoped key: organization first, so a caller cannot widen the lookup.
  findMembership(key: MembershipKey): Promise<MembershipRecord | null>;
  listMembershipsForUser(
    userId: string,
  ): Promise<OrganizationMembershipRecord[]>;
}

export function createMembershipReader(db: Database): MembershipReader {
  return {
    async findMembership({ userId, organizationId }) {
      if (!userId || !organizationId) return null;
      const rows = await db
        .select({
          membershipId: member.id,
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
        })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            eq(member.userId, userId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    async listMembershipsForUser(userId) {
      if (!userId) return [];
      return db
        .select({
          membershipId: member.id,
          organizationId: member.organizationId,
          userId: member.userId,
          role: member.role,
          organizationName: organization.name,
          organizationSlug: organization.slug,
        })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.userId, userId))
        .orderBy(organization.name);
    },
  };
}
