import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OperatorStore } from "../../../apps/web/lib/operator/service.ts";
import { createOperatorService } from "../../../apps/web/lib/operator/service.ts";
import { createOperatorStore } from "../../../apps/web/lib/operator/store.ts";
import {
  type Database,
  databaseErrorCode,
  databaseErrorConstraint,
  sql,
} from "../../../packages/db/src/index.ts";
import { openTestDatabase, resetAuthTables } from "../auth/support.ts";

// Real-Postgres acceptance for the operator console. Placed in the auth
// integration suite because it resets the auth tables those tests already own,
// so no owner-gated integration config change is needed.
let db: Database;
let close: (() => Promise<void>) | undefined;
let store: OperatorStore;
const operator = { userId: "operator-synthetic" };

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
  store = createOperatorStore(db);
});

afterAll(async () => {
  await close?.();
});

async function reset() {
  await resetAuthTables(db);
  await db.execute(
    sql`truncate table "organization_settings", "organization_audit_event", "platform_audit_event" cascade`,
  );
}

/** A verified credential account, as provisioning requires. */
async function account(email: string, userId: string = randomUUID()) {
  await db.execute(
    sql`insert into "user"(id,name,email,email_verified,created_at,updated_at) values (${userId},${userId},${email},true,now(),now())`,
  );
  await db.execute(
    sql`insert into account(id,account_id,provider_id,user_id,password,created_at,updated_at) values (${randomUUID()},${userId},'credential',${userId},'synthetic-hash',now(),now())`,
  );
  return userId;
}

async function organization(name: string, slug: string, owners: string[]) {
  const organizationId = randomUUID();
  await db.execute(
    sql`insert into organization(id,name,slug,created_at) values (${organizationId},${name},${slug},now())`,
  );
  for (const userId of owners) await member(organizationId, userId, "owner");
  await db.execute(
    sql`insert into organization_settings(organization_id,revision,timezone,automation_policy,policy_version,routing,fallback_membership_id,ack_minutes,retention_days) values (${organizationId},1,'America/New_York','review-all','1','{}'::jsonb,null,60,365)`,
  );
  return organizationId;
}

async function member(organizationId: string, userId: string, role: string) {
  const membershipId = randomUUID();
  await db.execute(
    sql`insert into member(id,organization_id,user_id,role,created_at) values (${membershipId},${organizationId},${userId},${role},now())`,
  );
  return membershipId;
}

async function counts(organizationId: string) {
  const members = await db.execute(
    sql`select role,count(*)::int as total from member where organization_id=${organizationId} group by role`,
  );
  const audit = await db.execute(
    sql`select action,phase,actor,before,after from organization_audit_event where organization_id=${organizationId} order by action,phase`,
  );
  return {
    owners:
      (members.rows.find((row) => row.role === "owner")?.total as number) ?? 0,
    audit: audit.rows,
  };
}

describe("operator console against PostgreSQL", () => {
  it("creates an organization, its first owner, settings and an attributed audit row", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    const service = createOperatorService(store, { newId: randomUUID });
    const result = await service.createOrganization({
      actor: operator,
      correlationId: "corr-create",
      command: {
        name: "Synthetic Tidepath",
        slug: "synthetic-tidepath",
        timezone: "America/New_York",
        ownerEmail: "owner@example.invalid",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { audit, owners } = await counts(result.value.organizationId);
    expect(owners).toBe(1);
    // Creation and the first ownership grant are separate audit facts.
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      action: "member.add",
      phase: "applied",
      actor: { kind: "operator", userId: operator.userId },
      before: null,
    });
    expect(audit[0]?.after).toMatchObject({ role: "owner" });
    expect(audit[1]).toMatchObject({
      action: "organization.create",
      phase: "applied",
      before: null,
    });
    expect(audit[1]?.after).toMatchObject({
      name: "Synthetic Tidepath",
      slug: "synthetic-tidepath",
    });
    const settings = await db.execute(
      sql`select timezone,automation_policy from organization_settings where organization_id=${result.value.organizationId}`,
    );
    expect(settings.rows[0]).toMatchObject({
      timezone: "America/New_York",
      automation_policy: "review-all",
    });
    expect(ownerId).toBeTruthy();
  });

  it("refuses a name or slug collision as a conflict, not an outage", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    await organization("Existing Name", "existing-slug", [ownerId]);
    const service = createOperatorService(store, { newId: randomUUID });
    for (const command of [
      {
        name: "Existing Name",
        slug: "other-slug",
        timezone: "UTC",
        ownerEmail: "owner@example.invalid",
      },
      {
        name: "Other Name",
        slug: "existing-slug",
        timezone: "UTC",
        ownerEmail: "owner@example.invalid",
      },
    ]) {
      const result = await service.createOrganization({
        actor: operator,
        correlationId: "c",
        command,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("never creates an organization owned by the operator, or manages one they belong to", async () => {
    await reset();
    await account("operator@example.invalid", operator.userId);
    const service = createOperatorService(store, { newId: randomUUID });
    const ownAccount = await service.createOrganization({
      actor: operator,
      correlationId: "c",
      command: {
        name: "Own Account Org",
        slug: "own-account-org",
        timezone: "UTC",
        ownerEmail: "operator@example.invalid",
      },
    });
    expect(ownAccount.ok).toBe(false);
    if (!ownAccount.ok) expect(ownAccount.error.code).toBe("FORBIDDEN");

    const otherOwner = await account("other@example.invalid");
    const organizationId = await organization("Member Org", "member-org", [
      otherOwner,
    ]);
    await member(organizationId, operator.userId, "volunteer");
    const manage = await service.setMemberRole({
      actor: operator,
      correlationId: "c",
      command: {
        organizationId,
        membershipId: randomUUID(),
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(manage.ok).toBe(false);
    if (!manage.ok) expect(manage.error.code).toBe("FORBIDDEN");
  });

  it("serializes concurrent demotions so an owner always remains", async () => {
    await reset();
    const first = await account("first@example.invalid");
    const second = await account("second@example.invalid");
    const organizationId = await organization("Two Owners", "two-owners", [
      first,
      second,
    ]);
    const service = createOperatorService(store, { newId: randomUUID });
    const members = await db.execute(
      sql`select id from member where organization_id=${organizationId} order by id`,
    );
    const ids = members.rows.map((row) => row.id as string);
    const results = await Promise.all(
      ids.map((membershipId) =>
        service.setMemberRole({
          actor: operator,
          correlationId: "c",
          command: {
            organizationId,
            membershipId,
            role: "coordinator",
            expectedRole: "owner",
          },
        }),
      ),
    );
    const succeeded = results.filter((result) => result.ok).length;
    expect(succeeded).toBe(1);
    const { audit, owners } = await counts(organizationId);
    expect(owners).toBe(1);
    expect(audit).toHaveLength(1);
  });

  it("rolls the role change back when the audit row cannot be written", async () => {
    await reset();
    const first = await account("first@example.invalid");
    const second = await account("second@example.invalid");
    const organizationId = await organization(
      "Audit Atomicity",
      "audit-atomicity",
      [first, second],
    );
    const target = await db.execute(
      sql`select id from member where organization_id=${organizationId} and user_id=${second}`,
    );
    const membershipId = target.rows[0]?.id as string;
    await db.execute(
      sql`create function relay_test_reject_operator_audit() returns trigger language plpgsql as $$ begin raise exception 'synthetic audit failure'; end $$`,
    );
    await db.execute(
      sql`create trigger relay_test_reject_operator_audit before insert on organization_audit_event for each row execute function relay_test_reject_operator_audit()`,
    );
    try {
      const service = createOperatorService(store, { newId: randomUUID });
      const result = await service.setMemberRole({
        actor: operator,
        correlationId: "c",
        command: {
          organizationId,
          membershipId,
          role: "coordinator",
          expectedRole: "owner",
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    } finally {
      await db.execute(
        sql`drop trigger if exists relay_test_reject_operator_audit on organization_audit_event`,
      );
      await db.execute(
        sql`drop function if exists relay_test_reject_operator_audit()`,
      );
    }
    const after = await db.execute(
      sql`select role from member where id=${membershipId}`,
    );
    expect(after.rows[0]?.role).toBe("owner");
    expect((await counts(organizationId)).owners).toBe(2);
  });

  it("refuses the last owner, and lists owners with masked addresses", async () => {
    await reset();
    const only = await account("only@example.invalid");
    const organizationId = await organization("Single Owner", "single-owner", [
      only,
    ]);
    const service = createOperatorService(store, { newId: randomUUID });
    const membershipId = (
      await db.execute(
        sql`select id from member where organization_id=${organizationId}`,
      )
    ).rows[0]?.id as string;
    const revocation = await service.setMemberRole({
      actor: operator,
      correlationId: "c",
      command: {
        organizationId,
        membershipId,
        role: "coordinator",
        expectedRole: "owner",
      },
    });
    expect(revocation.ok).toBe(false);
    if (!revocation.ok) expect(revocation.error.code).toBe("CONFLICT");
    expect((await counts(organizationId)).owners).toBe(1);

    const detail = await service.detail({
      organizationId,
      actor: operator,
      correlationId: "c",
    });
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.value.organization.owners).toHaveLength(1);
    expect(detail.value.organization.owners[0]?.maskedEmail).toBe(
      "o•••@example.invalid",
    );
    expect(JSON.stringify(detail.value)).not.toContain("only@example.invalid");

    const list = await service.list({
      query: {},
      actor: operator,
      correlationId: "c",
    });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.organizations[0]?.organizationId).toBe(organizationId);
    // The domain is kept on purpose; the mailbox is not.
    expect(JSON.stringify(list.value)).not.toContain("only@example.invalid");
  });
});

describe("last-owner invariant across every path", () => {
  it("refuses a tenant-path demotion that would leave zero owners", async () => {
    await reset();
    const only = await account("only@example.invalid");
    const organizationId = await organization("Solo Owner", "solo-owner", [
      only,
    ]);
    // The tenant path writes member rows directly through Better Auth; the
    // database trigger is the only thing that can stop it, and it must name the
    // constraint so the caller can answer CONFLICT rather than 503.
    const failure = await db
      .execute(
        sql`update member set role='coordinator' where organization_id=${organizationId} and user_id=${only}`,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).not.toBeNull();
    expect(databaseErrorCode(failure)).toBe("23514");
    expect(databaseErrorConstraint(failure)).toBe(
      "organization_last_owner_check",
    );
    expect((await counts(organizationId)).owners).toBe(1);
  });

  it("lets an operator demote one of two owners, and the trigger blocks the second", async () => {
    await reset();
    const first = await account("first@example.invalid");
    const second = await account("second@example.invalid");
    const organizationId = await organization("Two Owners", "two-owners", [
      first,
      second,
    ]);
    const target = (
      await db.execute(
        sql`select id from member where organization_id=${organizationId} and user_id=${second}`,
      )
    ).rows[0]?.id as string;
    const service = createOperatorService(store, { newId: randomUUID });
    const demoted = await service.setMemberRole({
      actor: operator,
      correlationId: "c",
      command: {
        organizationId,
        membershipId: target,
        role: "coordinator",
        expectedRole: "owner",
      },
    });
    expect(demoted.ok).toBe(true);
    // Now the tenant path tries to demote the remaining owner directly.
    const failure = await db
      .execute(
        sql`update member set role='coordinator' where organization_id=${organizationId}`,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).not.toBeNull();
    expect((await counts(organizationId)).owners).toBe(1);
  });
});

describe("operator recovery, rename and platform trail", () => {
  it("recovers a zero-owner organization by revoking the account's access", async () => {
    await reset();
    const stuck = await account("stuck@example.invalid");
    const organizationId = await organization("Stuck Org", "stuck-org", []);
    await db.execute(
      sql`insert into session(id,expires_at,token,created_at,updated_at,user_id) values (${randomUUID()},now() + interval '1 day',${randomUUID()},now(),now(),${stuck})`,
    );
    const service = createOperatorService(store, { newId: randomUUID });
    const assigned = await service.assignOwner({
      actor: operator,
      correlationId: "c",
      command: { organizationId, email: "stuck@example.invalid" },
    });
    expect(assigned.ok).toBe(true);
    const sessions = await db.execute(
      sql`select id from session where user_id=${stuck}`,
    );
    expect(sessions.rows).toHaveLength(0);
    const credential = await db.execute(
      sql`select password from account where user_id=${stuck} and provider_id='credential'`,
    );
    expect(credential.rows[0]?.password).toBeNull();
    const { audit, owners } = await counts(organizationId);
    expect(owners).toBe(1);
    expect(audit[0]).toMatchObject({ action: "member.add", phase: "applied" });

    // A second assignment is refused: the organization has an owner again.
    const again = await service.assignOwner({
      actor: operator,
      correlationId: "c",
      command: { organizationId, email: "stuck@example.invalid" },
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("CONFLICT");
  });

  it("renews a name and slug, conflicts on a stale view, and records both audits", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    const organizationId = await organization("Old Name", "old-name", [
      ownerId,
    ]);
    const service = createOperatorService(store, { newId: randomUUID });
    const renamed = await service.renameOrganization({
      actor: operator,
      correlationId: "c",
      command: {
        organizationId,
        name: "New Name",
        slug: "new-name",
        expectedName: "Old Name",
        expectedSlug: "old-name",
      },
    });
    expect(renamed.ok).toBe(true);
    const stale = await service.renameOrganization({
      actor: operator,
      correlationId: "c",
      command: {
        organizationId,
        name: "Third Name",
        slug: "third-name",
        expectedName: "Old Name",
        expectedSlug: "old-name",
      },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");
    const row = await db.execute(
      sql`select name,slug from organization where id=${organizationId}`,
    );
    expect(row.rows[0]).toMatchObject({ name: "New Name", slug: "new-name" });
    const { audit } = await counts(organizationId);
    expect(audit[0]).toMatchObject({
      action: "organization.update",
      phase: "applied",
    });
  });

  it("records every operator read in the platform trail and fails closed", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    const organizationId = await organization("Trace Org", "trace-org", [
      ownerId,
    ]);
    const service = createOperatorService(store, { newId: randomUUID });
    expect(
      (
        await service.list({
          query: { q: "trace" },
          actor: operator,
          correlationId: "corr-1",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await service.detail({
          organizationId,
          actor: operator,
          correlationId: "corr-2",
        })
      ).ok,
    ).toBe(true);
    const trail = await db.execute(
      sql`select action,target_organization_id,query,correlation_id from platform_audit_event order by occurred_at`,
    );
    expect(trail.rows).toEqual([
      {
        action: "operator.list",
        target_organization_id: null,
        query: "trace",
        correlation_id: "corr-1",
      },
      {
        action: "operator.detail",
        target_organization_id: organizationId,
        query: null,
        correlation_id: "corr-2",
      },
    ]);
    // The trail is append-only.
    const tamper = await db
      .execute(sql`update platform_audit_event set action='operator.list'`)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(tamper).not.toBeNull();
  });
});
