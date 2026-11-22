import { randomUUID } from "node:crypto";
import {
  OPERATOR_MEMBER_LIMIT,
  OPERATOR_OWNER_LIMIT,
  type OperatorMember,
  type OperatorOrganizationDetail,
} from "@relay/contracts";
import { type Database, provisionOrganization, sql } from "@relay/db";
import { maskEmail } from "./mask.ts";
import type {
  OperatorStore,
  OperatorTransaction,
  PlatformEvent,
} from "./service.ts";

type Row = Record<string, unknown>;
const rows = (result: { rows: Row[] }) => result.rows;
const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => Number(value ?? 0);
const iso = (value: unknown) =>
  new Date(value instanceof Date ? value : String(value)).toISOString();

function idList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

type Executor = Pick<Database, "execute">["execute"];

/**
 * Every statement below runs on the transaction client passed in, never on `db`.
 * The store interface is deliberately small: shared organization creation and
 * provisioning live in `packages/db/src/repositories/provisioning.ts` so the CLI
 * and the console cannot drift.
 */
function createTransaction(execute: Executor): OperatorTransaction {
  return {
    provision(input) {
      // The shared helper takes a strict creation command; the correlation id
      // is its own option, not part of the organization input.
      return provisionOrganization(
        execute,
        {
          name: input.name,
          slug: input.slug,
          timezone: input.timezone,
          ownerEmail: input.ownerEmail,
        },
        { correlationId: input.correlationId },
      );
    },
    async lockOrganization(organizationId) {
      // A plain read: the row locks below are what serialize this change, and
      // taking a shared organization lock first would invert the lock order the
      // tenant paths and the owner trigger use.
      const found = rows(
        await execute(
          sql`select id from organization where id=${organizationId}`,
        ),
      );
      return found.length > 0;
    },
    async hasMembership({ organizationId, userId }) {
      const found = rows(
        await execute(
          sql`select id from member where organization_id=${organizationId} and user_id=${userId}`,
        ),
      );
      return found.length > 0;
    },
    async rename({ organizationId, name, slug, expectedName, expectedSlug }) {
      // Same advisory lock as creation: the name has no unique index.
      await execute(
        sql`select pg_advisory_xact_lock(hashtextextended(lower(${name}),0))`,
      );
      const current = rows(
        await execute(
          sql`select name,slug from organization where id=${organizationId} for update`,
        ),
      )[0];
      if (!current)
        return {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Resource was not found",
            correlationId: "-",
            retryable: false,
          },
        };
      if (
        text(current.name) !== expectedName ||
        text(current.slug) !== expectedSlug
      )
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "The record changed. Refresh and try again",
            correlationId: "-",
            retryable: false,
          },
        };
      const taken = rows(
        await execute(
          sql`select 1 from organization where id<>${organizationId} and (slug=${slug} or lower(name)=lower(${name}))`,
        ),
      );
      if (taken.length > 0)
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "The record changed. Refresh and try again",
            correlationId: "-",
            retryable: false,
          },
        };
      await execute(
        sql`update organization set name=${name}, slug=${slug} where id=${organizationId}`,
      );
      return { ok: true, value: undefined };
    },
    async accessAccount(email) {
      const row = rows(
        await execute(
          sql`select u.id from "user" u join account a on a.user_id=u.id and a.provider_id='credential' and a.password is not null and length(a.password)>0 where lower(u.email)=${email} and u.email_verified=true limit 1`,
        ),
      )[0];
      const userId = text(row?.id);
      return userId === "" ? null : { userId };
    },
    async addOwnerMembership({ organizationId, userId, membershipId }) {
      await execute(
        sql`insert into member(id,organization_id,user_id,role,created_at) values (${membershipId},${organizationId},${userId},'owner',now())`,
      );
    },
    async revokeAccountAccess(userId) {
      await execute(sql`delete from session where user_id=${userId}`);
      await execute(
        sql`update account set password=null, updated_at=now() where user_id=${userId} and provider_id='credential'`,
      );
    },
    async ownerMemberships(organizationId) {
      return rows(
        await execute(
          sql`select id from member where organization_id=${organizationId} and role='owner' order by id`,
        ),
      ).map((row) => text(row.id));
    },
    async lockMemberRows({ organizationId, membershipId }) {
      const found = rows(
        await execute(
          // Ordered ids avoid a deadlock between two concurrent owner changes,
          // and NO KEY UPDATE keeps foreign keys from tenant inserts unblocked.
          sql`select id,user_id,role from member where organization_id=${organizationId} and (id=${membershipId} or role='owner') order by id for no key update`,
        ),
      );
      return found.map((row) => ({
        membershipId: text(row.id),
        userId: text(row.user_id),
        role: text(row.role),
      }));
    },
    async updateRole({ organizationId, membershipId, role }) {
      await execute(
        sql`update member set role=${role} where organization_id=${organizationId} and id=${membershipId}`,
      );
    },
    async recordAudit(entry) {
      await execute(
        sql`insert into organization_audit_event(organization_id,operation_id,phase,action,target_id,actor,correlation_id,before,after,occurred_at) values (${entry.organizationId},${randomUUID()},'applied',${entry.action},${entry.membershipId},${JSON.stringify({ kind: "operator", userId: entry.actor.userId })}::jsonb,${entry.correlationId},${entry.before === null ? null : JSON.stringify(entry.before)}::jsonb,${JSON.stringify(entry.after)}::jsonb,now())`,
      );
    },
    async recordPlatformEvent(event) {
      await insertPlatformEvent(execute, event);
    },
  };
}

async function insertPlatformEvent(execute: Executor, event: PlatformEvent) {
  await execute(
    sql`insert into platform_audit_event(id,operator_user_id,action,target_organization_id,query,correlation_id,occurred_at) values (${randomUUID()},${event.operatorUserId},${event.action},${event.targetOrganizationId},${event.query},${event.correlationId},now())`,
  );
}

/**
 * SQL adapter for the operator console. All cross-organization SQL lives here,
 * so the decisions in `service.ts` are testable without a database and the
 * tenant repositories stay untouched.
 *
 * NOTE: better to wrap the whole decision in ONE transaction. The service calls
 * `store.transaction`, so each `tx` method must run inside that transaction; the
 * adapter therefore exposes a transactional facade rather than bare `db` calls.
 */
export function createOperatorStore(db: Database): OperatorStore {
  return {
    recordPlatformEvent(event) {
      return insertPlatformEvent(db.execute.bind(db) as Executor, event);
    },
    async transaction(run) {
      return db.transaction((tx) =>
        run(createTransaction(tx.execute.bind(tx) as Executor)),
      );
    },
    async listOrganizations({ pattern, after, limit }) {
      const page = rows(
        await db.execute(
          sql`select id,lower(name) as sort_name,name,slug,created_at from organization
            where (${pattern}::text is null or lower(name) like ${pattern} or slug like ${pattern})
              and (${after?.[0] ?? null}::text is null or (lower(name),id) > (${after?.[0] ?? null},${after?.[1] ?? null}))
            order by sort_name,id limit ${limit + 1}`,
        ),
      );
      const pageRows = page.slice(0, limit);
      if (pageRows.length === 0) return { rows: [], hasMore: false };
      const ids = idList(pageRows.map((row) => text(row.id)));
      const [roleCounts, ownerRows, invitationCounts] = await Promise.all([
        db.execute(sql`select organization_id,role,count(*)::int as total
          from member where organization_id in (${ids}) group by 1,2`),
        db.execute(sql`select organization_id,id,member_name,email,created_at from (
            select m.organization_id,m.id,u.name as member_name,u.email,m.created_at,
              row_number() over (partition by m.organization_id order by u.name,m.id) as position
            from member m join "user" u on u.id=m.user_id
            where m.role='owner' and m.organization_id in (${ids})
          ) ranked where position <= ${OPERATOR_OWNER_LIMIT} order by organization_id,position`),
        db.execute(sql`select organization_id,count(*)::int as total
          from invitation where status='pending' and expires_at > now()
            and organization_id in (${ids}) group by 1`),
      ]);
      const counts = new Map<
        string,
        OperatorOrganizationDetail["organization"]["members"]
      >();
      for (const row of rows(roleCounts)) {
        const organizationId = text(row.organization_id);
        const members = counts.get(organizationId) ?? {
          owner: 0,
          coordinator: 0,
          volunteer: 0,
          reportReader: 0,
          total: 0,
        };
        const total = count(row.total);
        if (row.role === "owner") members.owner = total;
        else if (row.role === "coordinator") members.coordinator = total;
        else if (row.role === "volunteer") members.volunteer = total;
        else if (row.role === "report-reader") members.reportReader = total;
        members.total += total;
        counts.set(organizationId, members);
      }
      const owners = new Map<
        string,
        OperatorOrganizationDetail["organization"]["owners"]
      >();
      for (const row of rows(ownerRows)) {
        const organizationId = text(row.organization_id);
        const list = owners.get(organizationId) ?? [];
        list.push({
          membershipId: text(row.id),
          name: text(row.member_name),
          maskedEmail: maskEmail(text(row.email)),
          joinedAt: iso(row.created_at),
        });
        owners.set(organizationId, list);
      }
      const invitations = new Map(
        rows(invitationCounts).map((row) => [
          text(row.organization_id),
          count(row.total),
        ]),
      );
      return {
        rows: pageRows.map((row) => ({
          organizationId: text(row.id),
          sortName: text(row.sort_name),
          name: text(row.name),
          slug: text(row.slug),
          createdAt: iso(row.created_at),
          members: counts.get(text(row.id)) ?? {
            owner: 0,
            coordinator: 0,
            volunteer: 0,
            reportReader: 0,
            total: 0,
          },
          owners: owners.get(text(row.id)) ?? [],
          pendingInvitations: invitations.get(text(row.id)) ?? 0,
        })),
        hasMore: page.length > limit,
      };
    },
    async getOrganization(organizationId, memberLimit) {
      const organizationRow = rows(
        await db.execute(
          sql`select id,name,slug,created_at from organization where id=${organizationId}`,
        ),
      )[0];
      if (!organizationRow) return null;
      const [roleCounts, ownerRows, invitationCounts, memberRows] =
        await Promise.all([
          db.execute(sql`select role,count(*)::int as total from member
            where organization_id=${organizationId} group by 1`),
          db.execute(sql`select m.id,u.name as member_name,u.email,m.created_at
            from member m join "user" u on u.id=m.user_id
            where m.organization_id=${organizationId} and m.role='owner'
            order by u.name,m.id limit ${OPERATOR_OWNER_LIMIT}`),
          db.execute(sql`select count(*)::int as total from invitation
            where organization_id=${organizationId} and status='pending'
              and expires_at > now()`),
          db.execute(sql`select m.id,m.role,u.name as member_name,u.email,
              m.created_at,count(*) over () as total
            from member m join "user" u on u.id=m.user_id
            where m.organization_id=${organizationId}
            order by u.name,m.id limit ${Math.min(memberLimit, OPERATOR_MEMBER_LIMIT)}`),
        ]);
      const members = {
        owner: 0,
        coordinator: 0,
        volunteer: 0,
        reportReader: 0,
        total: 0,
      };
      for (const row of rows(roleCounts)) {
        const total = count(row.total);
        if (row.role === "owner") members.owner = total;
        else if (row.role === "coordinator") members.coordinator = total;
        else if (row.role === "volunteer") members.volunteer = total;
        else if (row.role === "report-reader") members.reportReader = total;
        members.total += total;
      }
      const owners = rows(ownerRows).map((row) => ({
        membershipId: text(row.id),
        name: text(row.member_name),
        maskedEmail: maskEmail(text(row.email)),
        joinedAt: iso(row.created_at),
      }));
      const memberList = rows(memberRows);
      return {
        organization: {
          organizationId: text(organizationRow.id),
          name: text(organizationRow.name),
          slug: text(organizationRow.slug),
          createdAt: iso(organizationRow.created_at),
          members,
          owners,
          ownersTruncated: members.owner > owners.length,
          pendingInvitations: count(rows(invitationCounts)[0]?.total),
        },
        members: memberList.map<OperatorMember>((row) => ({
          membershipId: text(row.id),
          name: text(row.member_name),
          maskedEmail: maskEmail(text(row.email)),
          role: text(row.role) as OperatorMember["role"],
          joinedAt: iso(row.created_at),
        })),
        membersTruncated: count(memberList[0]?.total) > memberList.length,
      };
    },
  };
}
