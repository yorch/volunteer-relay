import { describe, expect, it } from "vitest";
import {
  REPORT_DETAIL_ACTIVITIES_LIMIT,
  REPORT_DETAIL_WEEKS,
  REPORT_TOP_CONTRIBUTORS_LIMIT,
  REPORT_VOLUNTEERS_LIMIT,
  reportContributorSchema,
  reportDashboardSchema,
  reportDetailActivitySchema,
  reportDetailWeekSchema,
  reportDetailWeekStarts,
  reportQuerySchema,
  reportVolunteerDetailSchema,
  reportVolunteerSchema,
  reportWeekRange,
} from "./reports.ts";

describe("reportWeekRange", () => {
  it("returns the Monday–Sunday week for a mid-week instant", () => {
    // Wednesday 2026-11-11 12:00 UTC.
    expect(reportWeekRange("UTC", new Date("2026-11-11T12:00:00Z"))).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
  });
  it("treats Sunday as the last day of the week, not the first", () => {
    expect(reportWeekRange("UTC", new Date("2026-11-15T23:59:00Z"))).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
    expect(reportWeekRange("UTC", new Date("2026-11-16T00:00:00Z"))).toEqual({
      from: "2026-11-16",
      to: "2026-11-22",
    });
  });
  it("uses the organization's local date, not UTC", () => {
    // Monday 03:00 UTC is still Sunday evening in New York.
    const instant = new Date("2026-11-16T03:00:00Z");
    expect(reportWeekRange("America/New_York", instant)).toEqual({
      from: "2026-11-09",
      to: "2026-11-15",
    });
    // Sunday 20:00 UTC is already Monday morning in Auckland.
    expect(
      reportWeekRange("Pacific/Auckland", new Date("2026-11-15T20:00:00Z")),
    ).toEqual({ from: "2026-11-16", to: "2026-11-22" });
  });
  it("crosses month and year boundaries", () => {
    // Thursday 2027-01-01.
    expect(reportWeekRange("UTC", new Date("2027-01-01T08:00:00Z"))).toEqual({
      from: "2026-12-28",
      to: "2027-01-03",
    });
  });
  it("returns null rather than guessing for an invalid timezone or instant", () => {
    expect(reportWeekRange("Not/A_Zone", new Date())).toBeNull();
    expect(reportWeekRange("", new Date())).toBeNull();
    expect(reportWeekRange("UTC", new Date("invalid"))).toBeNull();
  });
});

describe("report dashboard contract", () => {
  it("keeps every additive field optional for older servers", () => {
    expect(reportDashboardSchema.safeParse({}).success).toBe(true);
  });
  it("accepts a complete staff dashboard and an unknown week", () => {
    expect(
      reportDashboardSchema.parse({
        weekRange: { from: "2026-11-09", to: "2026-11-15" },
        weekApprovedMinutes: 90,
        weekHours: 1.5,
        unassignedOpenNeeds: 2,
        topContributors: [
          {
            membershipId: "member-a",
            approvedMinutes: 90,
            approvedContributions: 1,
          },
        ],
        oldestQueuedReviewAt: "2026-11-08T10:00:00.000Z",
      }),
    ).toMatchObject({ weekHours: 1.5 });
    expect(
      reportDashboardSchema.safeParse({
        weekRange: null,
        weekApprovedMinutes: null,
        weekHours: null,
        oldestQueuedReviewAt: null,
      }).success,
    ).toBe(true);
  });
  it("rejects evidence fields and unknown keys on contributors", () => {
    expect(
      reportContributorSchema.safeParse({
        membershipId: "member-a",
        approvedMinutes: 30,
        approvedContributions: 1,
        sourceId: "source-1",
      }).success,
    ).toBe(false);
    expect(
      reportDashboardSchema.safeParse({ contributionIds: ["c1"] }).success,
    ).toBe(false);
  });
  it("bounds the contributor list and rejects negative or reversed values", () => {
    const one = {
      membershipId: "m",
      approvedMinutes: 1,
      approvedContributions: 1,
    };
    expect(
      reportDashboardSchema.safeParse({
        topContributors: Array.from(
          { length: REPORT_TOP_CONTRIBUTORS_LIMIT + 1 },
          () => one,
        ),
      }).success,
    ).toBe(false);
    expect(
      reportDashboardSchema.safeParse({ weekApprovedMinutes: -1 }).success,
    ).toBe(false);
    expect(
      reportDashboardSchema.safeParse({
        weekRange: { from: "2026-11-15", to: "2026-11-09" },
      }).success,
    ).toBe(false);
  });
  it("accepts the staff volunteer roster with a known zero and an unknown week", () => {
    const parsed = reportDashboardSchema.parse({
      volunteers: [
        {
          membershipId: "member-a",
          approvedMinutes: 0,
          weekApprovedMinutes: null,
          approvedContributions: 0,
          pendingContributions: 2,
          pendingUnknownDuration: 1,
        },
      ],
      volunteersTruncated: false,
    });
    expect(parsed.volunteers?.[0]?.approvedMinutes).toBe(0);
    expect(parsed.volunteers?.[0]?.weekApprovedMinutes).toBeNull();
    expect(
      reportDashboardSchema.safeParse({
        volunteers: [],
        volunteersTruncated: true,
      }).success,
    ).toBe(true);
  });
  it("pairs the roster with its truncation flag and bounds its length", () => {
    expect(reportDashboardSchema.safeParse({ volunteers: [] }).success).toBe(
      false,
    );
    expect(
      reportDashboardSchema.safeParse({ volunteersTruncated: false }).success,
    ).toBe(false);
    const row = {
      membershipId: "m",
      approvedMinutes: 30,
      weekApprovedMinutes: 0,
      approvedContributions: 1,
      pendingContributions: 0,
      pendingUnknownDuration: 0,
    };
    expect(
      reportDashboardSchema.safeParse({
        volunteers: Array.from({ length: REPORT_VOLUNTEERS_LIMIT }, () => row),
        volunteersTruncated: true,
      }).success,
    ).toBe(true);
    expect(
      reportDashboardSchema.safeParse({
        volunteers: Array.from(
          { length: REPORT_VOLUNTEERS_LIMIT + 1 },
          () => row,
        ),
        volunteersTruncated: true,
      }).success,
    ).toBe(false);
    expect(REPORT_VOLUNTEERS_LIMIT).toBeGreaterThan(
      REPORT_TOP_CONTRIBUTORS_LIMIT,
    );
  });
  it("rejects roster rows without contributions, evidence keys, pending minutes or impossible counts", () => {
    const row = {
      membershipId: "m",
      approvedMinutes: 30,
      weekApprovedMinutes: 30,
      approvedContributions: 1,
      pendingContributions: 1,
      pendingUnknownDuration: 1,
    };
    expect(reportVolunteerSchema.safeParse(row).success).toBe(true);
    expect(
      reportVolunteerSchema.safeParse({
        ...row,
        approvedContributions: 0,
        pendingContributions: 0,
        pendingUnknownDuration: 0,
      }).success,
    ).toBe(false);
    expect(
      reportVolunteerSchema.safeParse({ ...row, pendingUnknownDuration: 2 })
        .success,
    ).toBe(false);
    expect(
      reportVolunteerSchema.safeParse({ ...row, pendingMinutes: 45 }).success,
    ).toBe(false);
    expect(
      reportVolunteerSchema.safeParse({ ...row, sourceId: "s" }).success,
    ).toBe(false);
    expect(
      reportVolunteerSchema.safeParse({ ...row, approvedMinutes: -1 }).success,
    ).toBe(false);
    const { weekApprovedMinutes: _, ...missingWeek } = row;
    expect(reportVolunteerSchema.safeParse(missingWeek).success).toBe(false);
  });
  it("leaves the report query strict", () => {
    expect(
      reportQuerySchema.safeParse({ organizationId: "foreign" }).success,
    ).toBe(false);
  });
  it("accepts the optional CSV view and keeps existing queries unchanged", () => {
    expect(reportQuerySchema.parse({ from: "2026-11-01" })).toEqual({
      from: "2026-11-01",
    });
    expect(reportQuerySchema.parse({ view: "volunteers" })).toEqual({
      view: "volunteers",
    });
    expect(reportQuerySchema.parse({ view: "summary" }).view).toBe("summary");
    expect(reportQuerySchema.safeParse({ view: "sources" }).success).toBe(
      false,
    );
    expect(reportQuerySchema.safeParse({ view: "" }).success).toBe(false);
  });
});

describe("reportDetailWeekStarts", () => {
  it("lists the Mondays of the last eight weeks, oldest first", () => {
    expect(
      reportDetailWeekStarts({ from: "2026-11-09", to: "2026-11-15" }),
    ).toEqual([
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    expect(REPORT_DETAIL_WEEKS).toBe(8);
  });
  it("crosses a year boundary and honors a smaller count", () => {
    expect(
      reportDetailWeekStarts({ from: "2027-01-04", to: "2027-01-10" }, 2),
    ).toEqual(["2026-12-28", "2027-01-04"]);
  });
});

describe("volunteer detail contract", () => {
  const weeks = [
    "2026-09-21",
    "2026-09-28",
    "2026-10-05",
    "2026-10-12",
    "2026-10-19",
    "2026-10-26",
    "2026-11-02",
    "2026-11-09",
  ].map((weekStart) => ({ weekStart, approvedMinutes: 0 }));
  const activity = {
    activityId: "activity-1",
    kind: "Garden",
    localDate: "2026-11-10",
    approvedMinutes: 30,
    approvedContributions: 1,
  };
  const detail = {
    membershipId: "member-a",
    weeks,
    unknownDateContributions: 0,
    byActivity: [activity],
    byActivityTruncated: false,
  };
  it("accepts zero-filled weeks, an unknown week and an unknown activity date", () => {
    expect(reportVolunteerDetailSchema.safeParse(detail).success).toBe(true);
    expect(
      reportVolunteerDetailSchema.safeParse({ ...detail, weeks: null }).success,
    ).toBe(true);
    expect(
      reportVolunteerDetailSchema.safeParse({
        ...detail,
        byActivity: [{ ...activity, localDate: null }],
      }).success,
    ).toBe(true);
    expect(
      reportDashboardSchema.safeParse({ volunteerDetail: detail }).success,
    ).toBe(true);
  });
  it("requires exactly eight consecutive weeks, oldest first", () => {
    expect(
      reportVolunteerDetailSchema.safeParse({
        ...detail,
        weeks: weeks.slice(1),
      }).success,
    ).toBe(false);
    expect(
      reportVolunteerDetailSchema.safeParse({
        ...detail,
        weeks: [...weeks].reverse(),
      }).success,
    ).toBe(false);
    expect(
      reportVolunteerDetailSchema.safeParse({
        ...detail,
        weeks: weeks.map((w, i) =>
          i === 3 ? { ...w, weekStart: "2026-10-13" } : w,
        ),
      }).success,
    ).toBe(false);
  });
  it("bounds activities and rejects evidence keys, negative minutes or empty rows", () => {
    expect(
      reportVolunteerDetailSchema.safeParse({
        ...detail,
        byActivity: Array.from(
          { length: REPORT_DETAIL_ACTIVITIES_LIMIT + 1 },
          () => activity,
        ),
      }).success,
    ).toBe(false);
    expect(
      reportDetailActivitySchema.safeParse({ ...activity, sourceId: "s" })
        .success,
    ).toBe(false);
    expect(
      reportDetailActivitySchema.safeParse({
        ...activity,
        approvedContributions: 0,
      }).success,
    ).toBe(false);
    expect(
      reportDetailWeekSchema.safeParse({
        weekStart: "2026-11-09",
        approvedMinutes: -5,
      }).success,
    ).toBe(false);
    const { byActivityTruncated: _, ...missingFlag } = detail;
    expect(reportVolunteerDetailSchema.safeParse(missingFlag).success).toBe(
      false,
    );
  });
});
