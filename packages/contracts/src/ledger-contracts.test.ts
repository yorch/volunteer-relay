import { describe, expect, it } from "vitest";
import {
  activityRecordSchema,
  contributionListQuerySchema,
  contributionRecordSchema,
  contributionTransitionSchema,
  needListQuerySchema,
  needRecordSchema,
  recordActivityCommandSchema,
} from "./index.ts";

const origin = { kind: "staff", reason: "Shift log review" } as const;

const activityFacts = {
  kind: "Community kitchen shift",
  localDate: "2026-11-04",
  datePrecision: "day" as const,
  beneficiaryReference: null,
};

function recordActivity(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: "idem-activity-1",
    ...activityFacts,
    origin,
    contributions: [],
    ...overrides,
  };
}

function activityRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    organizationId: "tidepath",
    activityId: "activity-1",
    revision: 1,
    ...activityFacts,
    origin,
    createdAt: "2026-11-04T15:00:00Z",
    updatedAt: "2026-11-04T15:00:00Z",
    ...overrides,
  };
}

function contributionRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    organizationId: "tidepath",
    contributionId: "contribution-1",
    activityId: "activity-1",
    revision: 1,
    membershipId: "tidepath-mira",
    durationMinutes: 60,
    status: "pending",
    origin,
    createdAt: "2026-11-04T15:00:00Z",
    updatedAt: "2026-11-04T15:00:00Z",
    ...overrides,
  };
}

function needRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    organizationId: "tidepath",
    needId: "need-1",
    revision: 1,
    category: "Transport",
    urgency: "routine",
    summary: "Driver needed for Saturday pantry run",
    provisional: false,
    status: "new",
    ownerMembershipId: null,
    dueAt: null,
    acknowledgeBy: null,
    acknowledgedAt: null,
    acknowledgedByMembershipId: null,
    resolvedAt: null,
    resolution: null,
    origin,
    createdAt: "2026-11-04T15:00:00Z",
    updatedAt: "2026-11-04T15:00:00Z",
    ...overrides,
  };
}

describe("recordActivityCommandSchema", () => {
  it("accepts four drafts including two unresolved volunteers", () => {
    const command = recordActivity({
      contributions: [
        { membershipId: "m-1", durationMinutes: 60 },
        { membershipId: "m-2", durationMinutes: null },
        { membershipId: null, durationMinutes: 45 },
        { membershipId: null, durationMinutes: null },
      ],
    });
    expect(recordActivityCommandSchema.safeParse(command).success).toBe(true);
  });

  it("rejects a duplicated membership across drafts", () => {
    const command = recordActivity({
      contributions: [
        { membershipId: "m-1", durationMinutes: 60 },
        { membershipId: "m-1", durationMinutes: 30 },
      ],
    });
    expect(recordActivityCommandSchema.safeParse(command).success).toBe(false);
  });

  it("rejects precision/date mismatches in both directions", () => {
    expect(
      recordActivityCommandSchema.safeParse(
        recordActivity({ localDate: null, datePrecision: "day" }),
      ).success,
    ).toBe(false);
    expect(
      recordActivityCommandSchema.safeParse(
        recordActivity({ localDate: "2026-11-04", datePrecision: "unknown" }),
      ).success,
    ).toBe(false);
    expect(
      recordActivityCommandSchema.safeParse(
        recordActivity({ localDate: null, datePrecision: "unknown" }),
      ).success,
    ).toBe(true);
  });

  it("bounds duration minutes and accepts unknown as null", () => {
    for (const durationMinutes of [0, 1441, 1.5]) {
      expect(
        recordActivityCommandSchema.safeParse(
          recordActivity({
            contributions: [{ membershipId: "m-1", durationMinutes }],
          }),
        ).success,
      ).toBe(false);
    }
    for (const durationMinutes of [null, 1, 1440]) {
      expect(
        recordActivityCommandSchema.safeParse(
          recordActivity({
            contributions: [{ membershipId: "m-1", durationMinutes }],
          }),
        ).success,
      ).toBe(true);
    }
  });

  it("rejects blank or whitespace-only staff origin reasons", () => {
    for (const reason of ["", "   "]) {
      expect(
        recordActivityCommandSchema.safeParse(
          recordActivity({ origin: { kind: "staff", reason } }),
        ).success,
      ).toBe(false);
    }
  });
});

describe("contributionTransitionSchema", () => {
  const target = {
    schemaVersion: 1,
    idempotencyKey: "idem-1",
    contributionId: "contribution-1",
    expectedRevision: 2,
  };

  it("rejects an approve command carrying a reason key (strict shape)", () => {
    expect(
      contributionTransitionSchema.safeParse({
        ...target,
        action: "approve",
        reason: "should not be here",
      }).success,
    ).toBe(false);
  });

  it("accepts each declared action shape", () => {
    expect(
      contributionTransitionSchema.safeParse({ ...target, action: "approve" })
        .success,
    ).toBe(true);
    expect(
      contributionTransitionSchema.safeParse({
        ...target,
        action: "reject",
        reason: "Duplicate entry",
      }).success,
    ).toBe(true);
    expect(
      contributionTransitionSchema.safeParse({
        ...target,
        action: "correct",
        durationMinutes: 90,
        reason: "Timesheet correction",
      }).success,
    ).toBe(true);
    expect(
      contributionTransitionSchema.safeParse({
        ...target,
        action: "supersede",
        reason: "Recorded under the wrong activity",
      }).success,
    ).toBe(true);
  });
});

describe("needRecordSchema status consistency", () => {
  it("accepts a new need", () => {
    expect(needRecordSchema.safeParse(needRecord()).success).toBe(true);
  });

  it("rejects an assigned need without an owner", () => {
    expect(
      needRecordSchema.safeParse(needRecord({ status: "assigned" })).success,
    ).toBe(false);
  });

  it("accepts an acknowledged need with owner and acknowledgment", () => {
    expect(
      needRecordSchema.safeParse(
        needRecord({
          status: "acknowledged",
          ownerMembershipId: "m-owner",
          acknowledgedAt: "2026-11-04T16:00:00Z",
          acknowledgedByMembershipId: "m-owner",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a resolved need without a resolution", () => {
    expect(
      needRecordSchema.safeParse(
        needRecord({
          status: "resolved",
          resolvedAt: "2026-11-04T17:00:00Z",
        }),
      ).success,
    ).toBe(false);
    expect(
      needRecordSchema.safeParse(
        needRecord({
          status: "resolved",
          resolvedAt: "2026-11-04T17:00:00Z",
          resolution: "Covered by a neighbour",
        }),
      ).success,
    ).toBe(true);
  });
});

describe("contributionRecordSchema", () => {
  it("rejects an approved contribution with unknown duration", () => {
    expect(
      contributionRecordSchema.safeParse(
        contributionRecord({ status: "approved", durationMinutes: null }),
      ).success,
    ).toBe(false);
    expect(
      contributionRecordSchema.safeParse(
        contributionRecord({ status: "approved" }),
      ).success,
    ).toBe(true);
  });
});

describe("list query schemas", () => {
  it("accepts an empty contribution query and bounds the limit", () => {
    expect(contributionListQuerySchema.safeParse({}).success).toBe(true);
    expect(contributionListQuerySchema.safeParse({ limit: 101 }).success).toBe(
      false,
    );
    expect(contributionListQuerySchema.safeParse({ limit: 0 }).success).toBe(
      false,
    );
    expect(contributionListQuerySchema.safeParse({ limit: 100 }).success).toBe(
      true,
    );
  });

  it("bounds need list limits the same way", () => {
    expect(needListQuerySchema.safeParse({}).success).toBe(true);
    expect(needListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(needListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe("activityRecordSchema", () => {
  it("enforces precision/date consistency on stored records too", () => {
    expect(
      activityRecordSchema.safeParse(
        activityRecord({ localDate: null, datePrecision: "unknown" }),
      ).success,
    ).toBe(true);
    expect(
      activityRecordSchema.safeParse(
        activityRecord({ localDate: "2026-11-04", datePrecision: "unknown" }),
      ).success,
    ).toBe(false);
  });
});
