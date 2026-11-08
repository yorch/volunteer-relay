import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createModelBudgetRepository,
  sql,
} from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import { resetAuthTables } from "../auth/support.ts";
import {
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
  await fixture.db.execute(
    sql`truncate model_budget_reservation,model_budget_window`,
  );
  await resetAuthTables(fixture.db);
  await seedOrganizations(fixture.db);
  await seedDomainMembers(fixture.db);
});
const request = (organizationId: string, requestId: string) => ({
  organizationId,
  requestId,
  model: "synthetic-model",
  windowStart: "2026-11-01T00:00:00.000Z",
  windowEnd: "2026-12-01T00:00:00.000Z",
  limitMicroUsd: 100,
  inputTokenLimit: 30,
  outputTokenLimit: 20,
  inputMicroUsdPerMillion: 1000000,
  outputMicroUsdPerMillion: 1000000,
});
const repository = () =>
  createModelBudgetRepository(fixture.db, {
    now: () => new Date("2026-11-08T12:00:00Z"),
  });
it("enforces one deployment-wide ceiling across concurrent organizations", async () => {
  const repo = repository();
  const results = await Promise.all([
    repo.reserveModelBudget(request("tidepath", "a")),
    repo.reserveModelBudget(request("harbor", "b")),
    repo.reserveModelBudget(request("tidepath", "c")),
  ]);
  expect(results.filter((x) => x.ok)).toHaveLength(2);
  expect(results.filter((x) => !x.ok)).toHaveLength(1);
  const rows = await fixture.db.execute(
    sql`select count(*)::int as count,sum(reserved_micro_usd)::int as amount from model_budget_reservation`,
  );
  expect(rows.rows[0]).toEqual({ count: 2, amount: 100 });
});
it("keeps sent reservations charged until usage is settled, with immutable replay", async () => {
  const repo = repository();
  const reserved = await repo.reserveModelBudget(request("tidepath", "a"));
  if (!reserved.ok) throw new Error("missing reservation");
  expect(await repo.reserveModelBudget(request("tidepath", "a"))).toEqual(
    reserved,
  );
  expect(
    (await repo.markModelBudgetSent(reserved.value.reservationId)).ok,
  ).toBe(true);
  expect(
    await repo.markModelBudgetSent(reserved.value.reservationId),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(
    await repo.cancelModelBudget(reserved.value.reservationId),
  ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  expect(
    await repo.settleModelBudget(reserved.value.reservationId, {
      inputTokens: 60,
      outputTokens: 60,
    }),
  ).toEqual({ ok: true, value: { actualMicroUsd: 120 } });
  expect(
    await repo.settleModelBudget(reserved.value.reservationId, {
      inputTokens: 60,
      outputTokens: 60,
    }),
  ).toEqual({ ok: true, value: { actualMicroUsd: 120 } });
  expect(await repo.reserveModelBudget(request("harbor", "b"))).toMatchObject({
    ok: false,
    error: { code: "CONFLICT" },
  });
});
it("releases unsent reservations and fails closed on missing pricing or month mismatch", async () => {
  const repo = repository();
  const reserved = await repo.reserveModelBudget(request("tidepath", "a"));
  if (!reserved.ok) throw new Error("missing reservation");
  expect((await repo.cancelModelBudget(reserved.value.reservationId)).ok).toBe(
    true,
  );
  expect((await repo.reserveModelBudget(request("harbor", "b"))).ok).toBe(true);
  expect(
    await repo.reserveModelBudget({
      ...request("tidepath", "c"),
      inputMicroUsdPerMillion: 0,
      outputMicroUsdPerMillion: 0,
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(
    await repo.reserveModelBudget({
      ...request("tidepath", "c"),
      windowStart: "2026-10-01T00:00:00.000Z",
    }),
  ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});
