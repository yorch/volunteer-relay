import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createFollowThroughRepository,
  schema,
  sql,
} from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
  context,
  type DomainFixture,
  openDomainFixture,
  seedDomainMembers,
  staffOrigin,
} from "../domain/domain-support.ts";

let fixture: DomainFixture;
let clock: Date;
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
  clock = new Date("2026-11-08T12:00:00Z");
});
it("authorizes revisioned settings, replay and live routing", async () => {
  const repo = createFollowThroughRepository(fixture.db, { now: () => clock });
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  const update = {
    expectedRevision: 1,
    idempotencyKey: "settings",
    timezone: "America/New_York",
    automationPolicy: "review-all" as const,
    policyVersion: "1",
    routing: { Transport: ["tidepath-kai"] },
    fallbackMembershipId: "tidepath-rae",
    ackMinutes: 30,
    retentionDays: 90,
  };
  expect(await repo.updateSettings(staff, update)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  const a = await repo.updateSettings(owner, update);
  expect(a).toMatchObject({
    ok: true,
    value: { revision: 2, timezone: "America/New_York" },
  });
  expect(await repo.updateSettings(owner, update)).toEqual(a);
  expect(
    await repo.updateSettings(owner, { ...update, timezone: "UTC" }),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(
    await repo.updateSettings(owner, {
      ...update,
      idempotencyKey: "next",
      expectedRevision: 2,
      fallbackMembershipId: "harbor-ive",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  await fixture.db
    .delete(schema.member)
    .where(sql`${schema.member.id}='tidepath-rae'`);
  expect(await repo.getSettings(owner)).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
});
it("persists deduplicated alerts, bounded deliveries and stops after acknowledgment", async () => {
  const repo = createFollowThroughRepository(fixture.db, { now: () => clock });
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  const owner = await context(
    fixture.authorization,
    "user-rae",
    "tidepath",
    "owner",
  );
  expect(
    (
      await repo.updateSettings(owner, {
        expectedRevision: 1,
        idempotencyKey: "s",
        timezone: "UTC",
        automationPolicy: "review-all",
        policyVersion: "1",
        routing: { Transport: ["tidepath-kai"] },
        fallbackMembershipId: null,
        ackMinutes: 30,
        retentionDays: 90,
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await repo.setNotificationPreferences(staff, {
        email: true,
        telegram: false,
      })
    ).ok,
  ).toBe(true);
  const created = await fixture.needs.create(staff, {
    schemaVersion: 1,
    idempotencyKey: "create",
    category: "Transport",
    urgency: "urgent",
    summary: "Driver needed",
    provisional: false,
    dueAt: null,
    acknowledgeBy: null,
    origin: staffOrigin,
  });
  if (!created.ok) throw new Error("need not created");
  expect(
    (
      await fixture.needs.transition(staff, {
        schemaVersion: 1,
        idempotencyKey: "assign",
        needId: created.value.needId,
        expectedRevision: 1,
        action: "assign",
        ownerMembershipId: "tidepath-kai",
        acknowledgeBy: "2026-11-08T11:00:00Z",
      })
    ).ok,
  ).toBe(true);
  expect(await repo.processPendingNotifications(10)).toBe(2);
  expect(await repo.processPendingNotifications(10)).toBe(0);
  expect(await repo.escalateOverdue(10)).toBe(1);
  expect(await repo.escalateOverdue(10)).toBe(0);
  const list = await repo.listNotifications(staff);
  expect(list.ok && list.value.map((x) => x.type).sort()).toEqual([
    "need-assigned",
    "need-overdue",
  ]);
  const jobs = await repo.claimDeliveries(10);
  expect(jobs).toHaveLength(2);
  const first = jobs[0];
  if (!first) throw new Error("missing job");
  expect(
    await repo.completeDelivery(first, {
      status: "accepted",
      providerId: "synthetic",
    }),
  ).toBe(true);
  expect(
    (
      await fixture.needs.transition(staff, {
        schemaVersion: 1,
        idempotencyKey: "ack",
        needId: created.value.needId,
        expectedRevision: 2,
        action: "acknowledge",
      })
    ).ok,
  ).toBe(true);
  clock = new Date("2026-11-08T12:10:00Z");
  expect(await repo.claimDeliveries(10)).toEqual([]);
  expect(await repo.escalateOverdue(10)).toBe(0);
});
it("uses a hashed, expiring, single-use Telegram link and rechecks membership", async () => {
  const repo = createFollowThroughRepository(fixture.db, { now: () => clock });
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  const input = { idempotencyKey: "link", expiresAt: "2026-11-08T12:20:00Z" };
  const link = await repo.createTelegramLink(staff, input);
  if (!link.ok || !link.value.token) throw new Error("missing link");
  const raw = link.value.token;
  const stored = await fixture.db.execute(
    sql`select token_hash from telegram_link_token`,
  );
  expect(stored.rows[0]?.token_hash).not.toBe(raw);
  expect(await repo.createTelegramLink(staff, input)).toMatchObject({
    ok: true,
    value: { token: null },
  });
  expect(
    await repo.consumeTelegramLink(raw, "synthetic-telegram"),
  ).toMatchObject({
    ok: true,
    value: { organizationId: "tidepath", membershipId: "tidepath-kai" },
  });
  expect(
    await repo.consumeTelegramLink(raw, "synthetic-telegram"),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(
    await repo.resolveTelegramIdentity("synthetic-telegram"),
  ).toMatchObject({
    ok: true,
    value: { context: { organizationId: "tidepath" } },
  });
  await fixture.db
    .delete(schema.member)
    .where(sql`${schema.member.id}='tidepath-kai'`);
  expect(
    await repo.resolveTelegramIdentity("synthetic-telegram"),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});
it("rejects expired and revoked link tokens", async () => {
  const repo = createFollowThroughRepository(fixture.db, { now: () => clock });
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  const first = await repo.createTelegramLink(staff, {
    idempotencyKey: "expires",
    expiresAt: "2026-11-08T12:01:00Z",
  });
  if (!first.ok || !first.value.token) throw new Error("missing token");
  clock = new Date("2026-11-08T12:02:00Z");
  expect(await repo.consumeTelegramLink(first.value.token, "id")).toMatchObject(
    { ok: false, error: { code: "NOT_FOUND" } },
  );
  const second = await repo.createTelegramLink(staff, {
    idempotencyKey: "revoke",
    expiresAt: "2026-11-08T12:03:00Z",
  });
  if (!second.ok || !second.value.token) throw new Error("missing token");
  expect((await repo.revokeTelegramLink(staff, second.value.linkId)).ok).toBe(
    true,
  );
  expect(
    await repo.consumeTelegramLink(second.value.token, "id"),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});
it("blocks stale delivery completions after the lease expires", async () => {
  const repo = createFollowThroughRepository(fixture.db, { now: () => clock });
  const staff = await context(
    fixture.authorization,
    "user-kai",
    "tidepath",
    "staff",
  );
  expect(
    (
      await repo.setNotificationPreferences(staff, {
        email: true,
        telegram: false,
      })
    ).ok,
  ).toBe(true);
  const need = await fixture.needs.create(staff, {
    schemaVersion: 1,
    idempotencyKey: "create",
    category: "Transport",
    urgency: "urgent",
    summary: "Driver needed",
    provisional: false,
    dueAt: null,
    acknowledgeBy: null,
    origin: staffOrigin,
  });
  if (!need.ok) throw new Error("missing need");
  expect(
    (
      await fixture.needs.transition(staff, {
        schemaVersion: 1,
        idempotencyKey: "assign",
        needId: need.value.needId,
        expectedRevision: 1,
        action: "assign",
        ownerMembershipId: "tidepath-kai",
        acknowledgeBy: null,
      })
    ).ok,
  ).toBe(true);
  await repo.processPendingNotifications(10);
  const [old] = await repo.claimDeliveries(1);
  if (!old) throw new Error("missing claim");
  clock = new Date("2026-11-08T12:06:00Z");
  const [current] = await repo.claimDeliveries(1);
  if (!current) throw new Error("missing new claim");
  expect(
    await repo.completeDelivery(old, {
      status: "accepted",
      providerId: "late",
    }),
  ).toBe(false);
  expect(
    await repo.completeDelivery(current, {
      status: "accepted",
      providerId: "current",
    }),
  ).toBe(true);
});
