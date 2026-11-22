import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAuth,
  createRecordingMailer,
  type SessionResolver,
} from "../../../apps/web/lib/auth/index.ts";
import type { OperatorStore } from "../../../apps/web/lib/operator/service.ts";
import { createOperatorService } from "../../../apps/web/lib/operator/service.ts";
import { createOperatorStore } from "../../../apps/web/lib/operator/store.ts";
import { createFollowThroughHttp } from "../../../apps/web/lib/product/follow-through.ts";
import type { TenantContext } from "../../../packages/contracts/src/index.ts";
import {
  type Database,
  databaseErrorCode,
  databaseErrorConstraint,
  sql,
} from "../../../packages/db/src/index.ts";
import {
  openTestDatabase,
  resetAuthTables,
  resolveTestDatabaseUrl,
} from "../auth/support.ts";

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

/** Advisory locks on the database, granted or waiting, across all sessions. */
async function advisoryLocks(granted: boolean): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as total from pg_locks where locktype='advisory' and granted=${granted}`,
  );
  return (result.rows[0]?.total as number) ?? 0;
}

async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not reached in time");
}

/**
 * Holds the last-owner advisory lock in its own transaction, so a race can be
 * staged: every participant reaches the trigger before any of them can pass it.
 */
async function holdOwnerLock(organizationId: string) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('organization-owner:'||${organizationId},0))`,
    );
    await gate;
  });
  await waitFor(async () => (await advisoryLocks(true)) === 1);
  return {
    /** Resolves once `count` backends are blocked on that lock. */
    blocked: (count: number) =>
      waitFor(async () => (await advisoryLocks(false)) === count),
    release: async () => {
      release();
      await held;
    },
  };
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

describe("last-owner invariant under concurrency and on every trigger path", () => {
  it("serializes two concurrent tenant demotions without a deadlock", async () => {
    await reset();
    const first = await account("first@example.invalid");
    const second = await account("second@example.invalid");
    const organizationId = await organization("Two Owners", "two-owners", [
      first,
      second,
    ]);
    const ids = (
      await db.execute(
        sql`select id from member where organization_id=${organizationId} order by id`,
      )
    ).rows.map((row) => row.id as string);
    const demote = (membershipId: string) =>
      db.transaction(async (tx) => {
        await tx.execute(
          sql`update member set role='coordinator' where id=${membershipId}`,
        );
      });
    // Both statements reach the trigger before either can pass it, so this is
    // the real interleaving and not a lucky ordering.
    const gate = await holdOwnerLock(organizationId);
    const calls = [demote(ids[0] as string), demote(ids[1] as string)];
    await gate.blocked(2);
    await gate.release();
    const outcomes = await Promise.allSettled(calls);
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    // Locking owner rows inside the trigger used to surface the loser as 40P01
    // (a retryable deadlock) instead of the named constraint.
    for (const outcome of rejected) {
      expect(databaseErrorCode(outcome.reason)).toBe("23514");
      expect(databaseErrorConstraint(outcome.reason)).toBe(
        "organization_last_owner_check",
      );
    }
    expect((await counts(organizationId)).owners).toBe(1);
  });

  it("refuses deleting an organization's only owner membership", async () => {
    await reset();
    const only = await account("only@example.invalid");
    const organizationId = await organization("Solo Owner", "solo-owner", [
      only,
    ]);
    const failure = await db
      .execute(sql`delete from member where organization_id=${organizationId}`)
      .then(() => null)
      .catch((error: unknown) => error);
    expect(databaseErrorCode(failure)).toBe("23514");
    expect(databaseErrorConstraint(failure)).toBe(
      "organization_last_owner_check",
    );
    expect((await counts(organizationId)).owners).toBe(1);
  });

  it("refuses moving an organization's only owner to another organization", async () => {
    await reset();
    const only = await account("only@example.invalid");
    const elsewhere = await account("elsewhere@example.invalid");
    const organizationId = await organization("Origin Org", "origin-org", [
      only,
    ]);
    const target = await organization("Target Org", "target-org", [elsewhere]);
    const membershipId = (
      await db.execute(
        sql`select id from member where organization_id=${organizationId}`,
      )
    ).rows[0]?.id as string;
    const failure = await db
      .execute(
        sql`update member set organization_id=${target} where id=${membershipId}`,
      )
      .then(() => null)
      .catch((error: unknown) => error);
    expect(databaseErrorCode(failure)).toBe("23514");
    expect(databaseErrorConstraint(failure)).toBe(
      "organization_last_owner_check",
    );
    expect((await counts(organizationId)).owners).toBe(1);
    expect((await counts(target)).owners).toBe(1);
  });
});

describe("tenant member route and the database invariant", () => {
  const appUrl = "http://127.0.0.1:3101";
  const password = "synthetic-password-1";

  function cookieHeaders(setCookie: string | null): Headers {
    const cookie = (setCookie ?? "")
      .split(",")
      .map((part) => part.split(";")[0])
      .join("; ");
    return new Headers({ cookie });
  }

  it("answers CONFLICT when two owners demote themselves at once", async () => {
    await reset();
    const auth = createAuth({
      db,
      secret: "integration-test-secret-".padEnd(40, "x"),
      baseURL: appUrl,
      mail: createRecordingMailer(),
    });
    const signUp = async (email: string) => {
      const result = await auth.api.signUpEmail({
        body: { email, password, name: "Synthetic Person" },
        returnHeaders: true,
      });
      return {
        headers: cookieHeaders(result.headers.get("set-cookie")),
        userId: result.response.user.id,
      };
    };
    const first = await signUp("first@example.invalid");
    const second = await signUp("second@example.invalid");
    // Two owner memberships written directly: user-initiated organization
    // creation is disabled, and the invariant must hold whatever wrote the row.
    const organizationId = randomUUID();
    await db.execute(
      sql`insert into organization(id,name,slug,created_at) values (${organizationId},'Race Org','race-org',now())`,
    );
    const firstMembership = await member(organizationId, first.userId, "owner");
    const secondMembership = await member(
      organizationId,
      second.userId,
      "owner",
    );

    // The sessions resolver is only needed by the invitation path.
    const handler = createFollowThroughHttp(
      db,
      auth,
      {} as unknown as SessionResolver,
    );
    const demote = (
      person: { headers: Headers; userId: string },
      membershipId: string,
    ) => {
      const context: TenantContext = {
        organizationId: organizationId,
        actor: {
          kind: "user",
          userId: person.userId,
          membershipId,
          role: "owner",
        },
        correlationId: `corr-${membershipId}`,
      };
      return handler(
        context,
        "members/role",
        new Request(`${appUrl}/api/product/members/role`, {
          method: "POST",
          headers: new Headers({
            ...Object.fromEntries(person.headers),
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            organizationId: organizationId,
            membershipId,
            role: "coordinator",
          }),
        }),
      );
    };

    // Better Auth's own owner check runs without a lock, which is the race the
    // trigger closes. Hold the trigger's lock so both requests pass that check
    // and reach the database before either can finish.
    const gate = await holdOwnerLock(organizationId);
    const calls = [
      demote(first, firstMembership),
      demote(second, secondMembership),
    ];
    await gate.blocked(2);
    await gate.release();
    const outcomes = await Promise.all(calls);

    const succeeded = outcomes.filter((outcome) => outcome?.ok === true);
    const conflicts = outcomes.filter(
      (outcome) =>
        outcome !== null && !outcome.ok && outcome.error.code === "CONFLICT",
    );
    // CONFLICT, not a retryable outage: the caller can act on a stale view.
    expect(succeeded).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect((await counts(organizationId)).owners).toBe(1);
  });
});

describe("operator recovery, rename collisions and platform trail", () => {
  it("serializes two concurrent zero-owner recoveries to a single owner", async () => {
    await reset();
    await account("first@example.invalid");
    await account("second@example.invalid");
    const organizationId = await organization("Stuck Org", "stuck-org", []);
    const service = createOperatorService(store, { newId: randomUUID });
    const outcomes = await Promise.all([
      service.assignOwner({
        actor: operator,
        correlationId: "c-1",
        command: { organizationId, email: "first@example.invalid" },
      }),
      service.assignOwner({
        actor: operator,
        correlationId: "c-2",
        command: { organizationId, email: "second@example.invalid" },
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect((await counts(organizationId)).owners).toBe(1);
    // The refused recovery changed nothing, so its account keeps its password.
    const passwords = await db.execute(
      sql`select password from account where provider_id='credential' order by id`,
    );
    expect(passwords.rows.filter((row) => row.password === null)).toHaveLength(
      1,
    );
  });

  it("refuses a taken name, a taken slug and a promotion in a zero-owner organization", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    const otherOwner = await account("other@example.invalid");
    const coordinator = await account("coordinator@example.invalid");
    const organizationId = await organization("Old Name", "old-name", [
      ownerId,
    ]);
    await organization("Taken Name", "taken-name", [otherOwner]);
    const service = createOperatorService(store, { newId: randomUUID });

    const foreignName = await service.renameOrganization({
      actor: operator,
      correlationId: "c-name",
      command: {
        organizationId,
        name: "Taken Name",
        slug: "other-slug",
        expectedName: "Old Name",
        expectedSlug: "old-name",
      },
    });
    expect(foreignName.ok).toBe(false);
    if (!foreignName.ok) expect(foreignName.error.code).toBe("CONFLICT");

    // Case-only rename of itself: the self-exclusion is by id, not by name.
    const caseOnly = await service.renameOrganization({
      actor: operator,
      correlationId: "c-case",
      command: {
        organizationId,
        name: "OLD NAME",
        slug: "old-name",
        expectedName: "Old Name",
        expectedSlug: "old-name",
      },
    });
    expect(caseOnly.ok).toBe(true);
    const renamed = await db.execute(
      sql`select name,slug from organization where id=${organizationId}`,
    );
    expect(renamed.rows[0]).toMatchObject({
      name: "OLD NAME",
      slug: "old-name",
    });

    // Zero owners: a promotion would grant ownership without the recovery
    // revocation, so it is refused and points at member-add.
    const zeroOwners = await organization("Abandoned Org", "abandoned-org", []);
    const membershipId = await member(zeroOwners, coordinator, "coordinator");
    const promotion = await service.setMemberRole({
      actor: operator,
      correlationId: "c-promote",
      command: {
        organizationId: zeroOwners,
        membershipId,
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(promotion.ok).toBe(false);
    if (!promotion.ok) expect(promotion.error.code).toBe("FORBIDDEN");
    expect((await counts(zeroOwners)).owners).toBe(0);
    const recovery = await service.assignOwner({
      actor: operator,
      correlationId: "c-recover",
      command: {
        organizationId: zeroOwners,
        email: "coordinator@example.invalid",
      },
    });
    // Recovery cannot target an existing member: that is a state conflict the
    // operator resolves by inviting the person, as the ADR records.
    expect(recovery.ok).toBe(false);
    if (!recovery.ok) expect(recovery.error.code).toBe("CONFLICT");

    // The refused writes are on the platform trail, without any address.
    const trail = await db.execute(
      sql`select action,target_organization_id from platform_audit_event order by occurred_at`,
    );
    expect(trail.rows.map((row) => row.action)).toEqual([
      "organization.update.refused",
      "organization.update",
      "member.role.refused",
      "member.add.refused",
    ]);
    expect(JSON.stringify(trail.rows)).not.toContain("@");
  });

  it("maps a concurrent slug claim to CONFLICT through the unique index", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    const organizationId = await organization("Old Name", "old-name", [
      ownerId,
    ]);
    const racingId = randomUUID();
    // An uncommitted row is invisible to the uniqueness pre-check, so the
    // rename reaches the unique index instead: the 23505 path, not the check.
    let inserted = () => {};
    const insertStarted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    let releaseInsert = () => {};
    const hold = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const pendingInsert = db.transaction(async (tx) => {
      await tx.execute(
        sql`insert into organization(id,name,slug,created_at) values (${racingId},'Racing Org','race-slug',now())`,
      );
      inserted();
      await hold;
    });
    await insertStarted;
    let settled = false;
    const rename = createOperatorService(store, { newId: randomUUID })
      .renameOrganization({
        actor: operator,
        correlationId: "c-race",
        command: {
          organizationId,
          name: "Renamed Org",
          slug: "race-slug",
          expectedName: "Old Name",
          expectedSlug: "old-name",
        },
      })
      .finally(() => {
        settled = true;
      });
    // The statement is waiting on the index, not on the pre-check, which would
    // have answered at once because it cannot see an uncommitted row.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);
    releaseInsert();
    await pendingInsert;
    const result = await rename;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    const stored = await db.execute(
      sql`select slug from organization where id=${organizationId}`,
    );
    expect(stored.rows[0]?.slug).toBe("old-name");
  });

  it("fails closed when the platform trail cannot be recorded", async () => {
    await reset();
    const ownerId = await account("owner@example.invalid");
    const organizationId = await organization("Trace Org", "trace-org", [
      ownerId,
    ]);
    await db.execute(
      sql`create function relay_test_reject_platform_trail() returns trigger language plpgsql as $$ begin raise exception 'synthetic trail failure'; end $$`,
    );
    await db.execute(
      sql`create trigger relay_test_reject_platform_trail before insert on platform_audit_event for each row execute function relay_test_reject_platform_trail()`,
    );
    const service = createOperatorService(store, { newId: randomUUID });
    try {
      const detail = await service.detail({
        organizationId,
        actor: operator,
        correlationId: "c-detail",
      });
      expect(detail.ok).toBe(false);
      if (!detail.ok) {
        expect(detail.error.code).toBe("DEPENDENCY_UNAVAILABLE");
        expect(detail.error.retryable).toBe(true);
      }
      const list = await service.list({
        query: {},
        actor: operator,
        correlationId: "c-list",
      });
      // No organizations are returned when the trail cannot be written.
      expect(list.ok).toBe(false);
    } finally {
      await db.execute(
        sql`drop trigger if exists relay_test_reject_platform_trail on platform_audit_event`,
      );
      await db.execute(
        sql`drop function if exists relay_test_reject_platform_trail()`,
      );
    }
    const trail = await db.execute(sql`select id from platform_audit_event`);
    expect(trail.rows).toHaveLength(0);
  });
});

describe("provisioning CLI", () => {
  function runCli(args: string[]) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ["scripts/provision-organization.ts", ...args],
          {
            cwd: process.cwd(),
            env: { ...process.env, DATABASE_URL: resolveTestDatabaseUrl() },
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
  }

  it("creates through the shared helper and rolls a refusal back", async () => {
    await reset();
    await account("cli-owner@example.invalid");
    const created = await runCli([
      "--email",
      "cli-owner@example.invalid",
      "--name",
      "CLI Org",
      "--slug",
      "cli-org",
      "--timezone",
      "UTC",
    ]);
    expect(created.code).toBe(0);
    const organizationId = (
      JSON.parse(created.stdout) as { organizationId: string }
    ).organizationId;
    const shape = await db.execute(
      sql`select o.name,o.slug,s.timezone,(select count(*)::int from member where organization_id=o.id and role='owner') as owners from organization o join organization_settings s on s.organization_id=o.id where o.id=${organizationId}`,
    );
    expect(shape.rows[0]).toMatchObject({
      name: "CLI Org",
      slug: "cli-org",
      timezone: "UTC",
      owners: 1,
    });

    // A taken name exits non-zero with the documented message and writes nothing.
    const duplicate = await runCli([
      "--email",
      "cli-owner@example.invalid",
      "--name",
      "CLI Org",
      "--slug",
      "cli-org-two",
      "--timezone",
      "UTC",
    ]);
    expect(duplicate.code).toBe(1);
    expect(duplicate.stderr.trim()).toBe(
      "Organization name or slug already exists",
    );

    // An account that cannot own anything is refused before any write: the
    // failure throws inside the transaction callback, so nothing commits.
    const unknown = await runCli([
      "--email",
      "nobody@example.invalid",
      "--name",
      "Nobody Org",
      "--slug",
      "nobody-org",
      "--timezone",
      "UTC",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr.trim()).toBe(
      "A verified credential account is required",
    );
    const rows = await db.execute(
      sql`select slug from organization where slug like 'cli-org%' or slug='nobody-org' order by slug`,
    );
    expect(rows.rows).toEqual([{ slug: "cli-org" }]);
  });
});
