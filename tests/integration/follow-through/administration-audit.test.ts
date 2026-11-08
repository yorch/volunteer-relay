import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createAdministrationAuditRepository,
  createFollowThroughRepository,
  sql,
} from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
  seedDomainMembers,
} from "../domain/domain-support.ts";

let fixture: DomainFixture;
beforeAll(async () => {
  fixture = await openDomainFixture();
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(async () => {
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
});
it("writes settings audit atomically and only once on replay", async () => {
  const repo = createFollowThroughRepository(fixture.db);
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "settings",
  );
  const input = {
    expectedRevision: 1,
    idempotencyKey: "settings",
    timezone: "UTC",
    automationPolicy: "review-all" as const,
    policyVersion: "2",
    routing: {},
    fallbackMembershipId: null,
    ackMinutes: 30,
    retentionDays: 100,
  };
  await fixture.db.execute(
    sql`alter table organization_audit_event add constraint audit_test_failure check (action<>'settings.update')`,
  );
  try {
    expect(await repo.updateSettings(owner, input)).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE" },
    });
    expect(await repo.getSettings(owner)).toMatchObject({
      ok: true,
      value: { revision: 1 },
    });
  } finally {
    await fixture.db.execute(
      sql`alter table organization_audit_event drop constraint audit_test_failure`,
    );
  }
  const first = await repo.updateSettings(owner, input);
  expect(first.ok).toBe(true);
  expect(await repo.updateSettings(owner, input)).toEqual(first);
  const rows = await fixture.db.execute(
    sql`select phase,action,actor,before,after from organization_audit_event`,
  );
  expect(rows.rows).toMatchObject([
    {
      phase: "applied",
      action: "settings.update",
      actor: { kind: "user", membershipId: "tidepath-rae" },
      before: { revision: 1 },
      after: { revision: 2, policyVersion: "2" },
    },
  ]);
  await expect(
    fixture.db.execute(
      sql`update organization_audit_event set action='member.role'`,
    ),
  ).rejects.toThrow();
});
it("records owner requests and original actor in one idempotent terminal phase", async () => {
  const repo = createAdministrationAuditRepository(fixture.db);
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "member",
  );
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "member",
  );
  expect(
    await repo.beginOperation(staff, {
      action: "member.remove",
      targetId: "tidepath-mira",
    }),
  ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  expect(
    await repo.beginOperation(owner, {
      action: "member.role",
      targetId: "harbor-ive",
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(
    await repo.beginOperation(owner, {
      action: "member.invite",
      targetId: "person@example.invalid",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  const requested = await repo.beginOperation(owner, {
    action: "member.remove",
    targetId: "tidepath-mira",
  });
  if (!requested.ok) throw new Error("missing operation");
  const pending = await fixture.db.execute(
    sql`select phase from organization_audit_event where operation_id=${requested.value.operationId}`,
  );
  expect(pending.rows).toEqual([{ phase: "requested" }]);
  await expect(
    repo.finishOperation("harbor", requested.value.operationId, "succeeded"),
  ).rejects.toThrow();
  await repo.finishOperation(
    "tidepath",
    requested.value.operationId,
    "succeeded",
  );
  await repo.finishOperation(
    "tidepath",
    requested.value.operationId,
    "succeeded",
  );
  await expect(
    repo.finishOperation("tidepath", requested.value.operationId, "failed"),
  ).rejects.toThrow();
  const rows = await fixture.db.execute(
    sql`select phase,actor from organization_audit_event where operation_id=${requested.value.operationId} order by phase`,
  );
  expect(rows.rows).toMatchObject([
    { phase: "requested", actor: { membershipId: "tidepath-rae" } },
    { phase: "succeeded", actor: { membershipId: "tidepath-rae" } },
  ]);
});
