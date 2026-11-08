import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiError,
  Result,
  SourceEnvelope,
} from "../../../packages/contracts/src/index.ts";
import { createSourceStore, sql } from "../../../packages/db/src/index.ts";
import { seedOrganizations } from "../../../packages/db/src/seed-data.ts";
import {
  createLedgerService,
  createSourceRepository,
} from "../../../packages/domain/core/src/index.ts";
import { expectDatabaseRejection, resetAuthTables } from "../auth/support.ts";
import {
  context,
  type DomainFixture,
  HARBOR,
  onlyContribution,
  openDomainFixture,
  seedDomainMembers,
  staffOrigin,
  TIDEPATH,
} from "./domain-support.ts";

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

function errorOf<T>(result: Result<T>): ApiError["error"] {
  if (result.ok) throw new Error("expected a failure result");
  return result.error;
}

const tidepathCoordinator = (corr: string) =>
  context(fixture.authorization, "user-kai", TIDEPATH, corr);
const harborCoordinator = (corr: string) =>
  context(fixture.authorization, "user-ive", HARBOR, corr);
const harborVolunteer = (corr: string) =>
  context(fixture.authorization, "user-nico", HARBOR, corr);

const activityCommand = (idempotencyKey: string, overrides = {}) => ({
  schemaVersion: 1 as const,
  idempotencyKey,
  kind: "Kitchen shift",
  localDate: "2026-11-04",
  datePrecision: "day" as const,
  beneficiaryReference: null,
  origin: staffOrigin,
  contributions: [{ membershipId: "tidepath-mira", durationMinutes: 60 }],
  ...overrides,
});

async function recordTidepathActivity(idempotencyKey: string) {
  const recorded = await fixture.ledger.recordActivity(
    await tidepathCoordinator("corr-tidepath-seed"),
    activityCommand(idempotencyKey),
  );
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) throw new Error("seed activity failed");
  return recorded.value;
}

describe("cross-tenant concealment", () => {
  it("returns NOT_FOUND for Tidepath aggregates accessed from Harbor", async () => {
    const recorded = await recordTidepathActivity("idem-x-1");
    const activityId = recorded.activity.activityId;
    const contributionId = onlyContribution(recorded).contributionId;
    const ive = await harborCoordinator("corr-harbor-read");

    expect(
      errorOf(await fixture.ledger.getActivity(ive, activityId)).code,
    ).toBe("NOT_FOUND");

    expect(
      errorOf(
        await fixture.ledger.transitionContribution(ive, {
          schemaVersion: 1,
          idempotencyKey: "idem-x-approve",
          contributionId,
          expectedRevision: 1,
          action: "approve",
        }),
      ).code,
    ).toBe("NOT_FOUND");

    expect(
      errorOf(
        await fixture.ledger.addContribution(ive, {
          schemaVersion: 1,
          idempotencyKey: "idem-x-add",
          activityId,
          membershipId: "harbor-nico",
          durationMinutes: 20,
          origin: staffOrigin,
        }),
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for Tidepath needs accessed from Harbor", async () => {
    const kai = await tidepathCoordinator("corr-need-seed");
    const created = await fixture.needs.create(kai, {
      schemaVersion: 1,
      idempotencyKey: "idem-x-need",
      category: "Transport",
      urgency: "routine",
      summary: "Driver needed",
      provisional: false,
      dueAt: null,
      acknowledgeBy: null,
      origin: staffOrigin,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const ive = await harborCoordinator("corr-harbor-need");

    expect(
      errorOf(await fixture.needs.get(ive, created.value.needId)).code,
    ).toBe("NOT_FOUND");
    expect(
      errorOf(
        await fixture.needs.transition(ive, {
          schemaVersion: 1,
          idempotencyKey: "idem-x-need-t",
          needId: created.value.needId,
          expectedRevision: 1,
          action: "resolve",
          resolution: "Cross-tenant attempt",
        }),
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("rejects a Tidepath recordActivity naming a Harbor membership", async () => {
    const kai = await tidepathCoordinator("corr-x-member");
    const result = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-x-2", {
        contributions: [{ membershipId: "harbor-nico", durationMinutes: 15 }],
      }),
    );
    const error = errorOf(result);
    expect(error.code).toBe("VALIDATION");
    expect(error.fields?.membershipId).toBeDefined();
  });

  it("rejects an origin pointing at a Harbor source revision", async () => {
    // A real Harbor source revision exists behind the other tenant's boundary.
    const harborRepo = createSourceRepository({
      authorization: fixture.authorization,
      store: createSourceStore(fixture.db),
    });
    const nico = await harborVolunteer("corr-harbor-source");
    const envelope: SourceEnvelope = {
      schemaVersion: 1,
      organizationId: HARBOR,
      sourceId: "harbor-source-1",
      revision: 1,
      channel: "web",
      channelIdentity: "web-harbor",
      externalMessageId: "harbor-external-1",
      idempotencyKey: "idem-harbor-src",
      author: { externalIdentity: "Nico", membershipId: "harbor-nico" },
      occurredAt: "2026-11-04T15:00:00Z",
      receivedAt: "2026-11-04T15:01:00Z",
      timezone: "America/New_York",
      text: "Synthetic harbor source text.",
      attachments: [],
      replyToSourceId: null,
      replacesRevision: null,
      original: {
        mediaType: "text/plain",
        payload: "Synthetic harbor source text.",
      },
    };
    expect((await harborRepo.accept(nico, envelope)).ok).toBe(true);

    const kai = await tidepathCoordinator("corr-x-origin");
    const result = await fixture.ledger.recordActivity(
      kai,
      activityCommand("idem-x-3", {
        origin: {
          kind: "source",
          sourceId: "harbor-source-1",
          sourceRevision: 1,
        },
      }),
    );
    const error = errorOf(result);
    expect(error.code).toBe("VALIDATION");
    expect(error.fields?.origin).toBeDefined();
  });

  it("enforces tenant scoping on raw writes", async () => {
    // A Harbor activity row exists under the same id space.
    const nicoFixture = fixture;
    const ive = await harborCoordinator("corr-harbor-activity");
    const harborRecorded = await nicoFixture.ledger.recordActivity(
      ive,
      activityCommand("idem-h-1", {
        contributions: [{ membershipId: "harbor-nico", durationMinutes: 10 }],
      }),
    );
    expect(harborRecorded.ok).toBe(true);
    if (!harborRecorded.ok) return;
    const harborActivityId = harborRecorded.value.activity.activityId;

    // Raw SQL: a Tidepath contribution cannot reference the Harbor activity.
    await expectDatabaseRejection(
      () =>
        fixture.db.execute(sql`
          insert into contribution (
            organization_id, id, revision, activity_id, membership_id,
            duration_minutes, status,
            origin_kind, origin_reason
          ) values (
            ${TIDEPATH}, 'raw-contribution-1', 1, ${harborActivityId}, null,
            30, 'pending', 'staff', 'raw insert'
          )
        `),
      "23503",
    );
  });

  it("accepts the same opaque aggregate id independently per tenant", async () => {
    // Both tenants get an activity with the same id via injected generator.
    const fixed = () => "shared-opaque-id";
    const tidepathLedger = createLedgerService({
      authorization: fixture.authorization,
      store: fixture.store,
      ids: fixed,
    });
    const harborLedger = createLedgerService({
      authorization: fixture.authorization,
      store: fixture.store,
      ids: fixed,
    });

    const first = await tidepathLedger.recordActivity(
      await tidepathCoordinator("corr-shared-a"),
      activityCommand("idem-shared-a", { contributions: [] }),
    );
    const second = await harborLedger.recordActivity(
      await harborCoordinator("corr-shared-b"),
      activityCommand("idem-shared-b", { contributions: [] }),
    );
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.activity.activityId).toBe("shared-opaque-id");
    expect(second.value.activity.activityId).toBe("shared-opaque-id");
    expect(first.value.activity.organizationId).toBe(TIDEPATH);
    expect(second.value.activity.organizationId).toBe(HARBOR);
  });
});
