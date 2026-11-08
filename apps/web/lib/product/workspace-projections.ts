import type { TenantContext, WorkspaceSnapshot } from "@relay/contracts";
import { type Database, sql } from "@relay/db";

/** Small batched staff-only facts; never a public or report-reader projection. */
export function createWorkspaceActivityReader(db: Database) {
  return async (
    context: TenantContext,
    activityIds: readonly string[],
  ): Promise<NonNullable<WorkspaceSnapshot["activities"]>> => {
    const actor = context.actor;
    if (actor.kind !== "user" || !["owner", "coordinator"].includes(actor.role))
      return [];
    const ids = [...new Set(activityIds)].slice(0, 100);
    if (!ids.length) return [];
    const rows = await db.execute(
      sql`select a.id as "activityId",a.kind,to_char(a.local_date,'YYYY-MM-DD') as "localDate" from activity a where a.organization_id=${context.organizationId} and a.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}) and exists(select 1 from member m where m.organization_id=a.organization_id and m.id=${actor.membershipId} and m.user_id=${actor.userId} and m.role=${actor.role} and m.role in ('owner','coordinator')) order by a.id`,
    );
    return rows.rows.map((row) => ({
      activityId: String(row.activityId),
      kind: String(row.kind),
      localDate: row.localDate === null ? null : String(row.localDate),
    }));
  };
}
