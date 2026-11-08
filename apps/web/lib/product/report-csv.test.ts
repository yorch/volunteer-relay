import { describe, expect, it } from "vitest";
import {
  buildProductReport,
  csvCell,
  reportCsv,
  topContributors,
  VOLUNTEER_CSV_COLUMNS,
  volunteerCsv,
  volunteerDetail,
  volunteerRoster,
} from "./report-csv.ts";

const base = {
  query: {},
  timezone: "UTC",
  totals: {
    minutes: 150,
    approved: 3,
    visits: 2,
    pending: 2,
    unknown: 1,
    unresolved: 1,
  },
  needs: { open: 3, resolved: 1, ack: null, resolution: "45", unassigned: 2 },
  unknownDate: { count: 4 },
  weekRange: { from: "2026-11-02", to: "2026-11-08" },
  week: { minutes: 0 },
  contributors: null,
  oldestQueued: null,
};

function parseCsv(text: string) {
  const [header = "", row = ""] = text.split("\r\n");
  const cells = (line: string) =>
    [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) =>
      (m[1] ?? "").replaceAll('""', '"'),
    );
  return Object.fromEntries(
    cells(header).map((key, i) => [key, cells(row)[i]]),
  );
}

describe("csvCell", () => {
  it.each([
    ["=SUM(A1)", `"'=SUM(A1)"`],
    ["+1", `"'+1"`],
    ["-1", `"'-1"`],
    ["@cmd", `"'@cmd"`],
    ["\tx", `"'\tx"`],
    ["\rx", `"'\rx"`],
  ])("neutralizes the formula prefix in %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
  it("doubles embedded quotes and keeps newlines inside one quoted cell", () => {
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });
  it("leaves ordinary values alone and shows unknown as empty, never zero", () => {
    expect(csvCell("Garden")).toBe('"Garden"');
    expect(csvCell(12)).toBe('"12"');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
});

describe("topContributors", () => {
  it("ranks by minutes, then count, then id, and drops unresolved members", () => {
    expect(
      topContributors([
        { membership_id: "b", minutes: 60, approved: 1 },
        { membership_id: null, minutes: 999, approved: 9 },
        { membership_id: "a", minutes: 60, approved: 2 },
        { membership_id: "c", minutes: 120, approved: 1 },
        { membership_id: "d", minutes: 60, approved: 1 },
        { membership_id: "e", minutes: 0, approved: 0 },
      ]),
    ).toEqual([
      { membershipId: "c", approvedMinutes: 120, approvedContributions: 1 },
      { membershipId: "a", approvedMinutes: 60, approvedContributions: 2 },
      { membershipId: "b", approvedMinutes: 60, approvedContributions: 1 },
      { membershipId: "d", approvedMinutes: 60, approvedContributions: 1 },
    ]);
  });
  it("respects the limit", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => ({
      membership_id: id,
      minutes: 10 * (i + 1),
      approved: 1,
    }));
    expect(topContributors(rows)).toHaveLength(5);
    expect(topContributors(rows, 2).map((c) => c.membershipId)).toEqual([
      "g",
      "f",
    ]);
  });
});

describe("volunteerRoster", () => {
  const row = (
    membership_id: unknown,
    minutes: number,
    approved: number,
    pending = 0,
    unknown = 0,
    week_minutes = 0,
  ) => ({ membership_id, minutes, approved, pending, unknown, week_minutes });

  it("orders by approved minutes, then membership id, keeping pending-only members at a known zero", () => {
    expect(
      volunteerRoster(
        [
          row("m-b", 60, 1),
          row("m-pending", 0, 0, 2, 1),
          row("m-a", 60, 3, 1, 0, 60),
          row("m-c", 120, 1, 0, 0, 30),
        ],
        { weekKnown: true },
      ),
    ).toEqual({
      volunteers: [
        {
          membershipId: "m-c",
          approvedMinutes: 120,
          weekApprovedMinutes: 30,
          approvedContributions: 1,
          pendingContributions: 0,
          pendingUnknownDuration: 0,
        },
        {
          membershipId: "m-a",
          approvedMinutes: 60,
          weekApprovedMinutes: 60,
          approvedContributions: 3,
          pendingContributions: 1,
          pendingUnknownDuration: 0,
        },
        {
          membershipId: "m-b",
          approvedMinutes: 60,
          weekApprovedMinutes: 0,
          approvedContributions: 1,
          pendingContributions: 0,
          pendingUnknownDuration: 0,
        },
        {
          membershipId: "m-pending",
          approvedMinutes: 0,
          weekApprovedMinutes: 0,
          approvedContributions: 0,
          pendingContributions: 2,
          pendingUnknownDuration: 1,
        },
      ],
      volunteersTruncated: false,
    });
  });
  it("breaks ties by code unit, not locale", () => {
    const { volunteers } = volunteerRoster(
      [row("b", 10, 1), row("B", 10, 1), row("a", 10, 1)],
      { weekKnown: true },
    );
    expect(volunteers.map((v) => v.membershipId)).toEqual(["B", "a", "b"]);
  });
  it("reports the week as unknown (null), not zero, when the week is unknown", () => {
    const { volunteers } = volunteerRoster([row("m", 30, 1, 0, 0, 30)], {
      weekKnown: false,
    });
    expect(volunteers[0]?.weekApprovedMinutes).toBeNull();
  });
  it("drops unresolved members and rows with nothing in scope, and coerces database strings", () => {
    const { volunteers } = volunteerRoster(
      [
        row(null, 90, 1),
        row("", 90, 1),
        row("m-empty", 0, 0, 0, 0, 45),
        {
          membership_id: "m-str",
          minutes: "75",
          approved: "2",
          pending: "3",
          unknown: "9",
          week_minutes: "15",
        },
      ],
      { weekKnown: true },
    );
    expect(volunteers).toEqual([
      {
        membershipId: "m-str",
        approvedMinutes: 75,
        weekApprovedMinutes: 15,
        approvedContributions: 2,
        pendingContributions: 3,
        // Unknown-duration pending is a subset of pending.
        pendingUnknownDuration: 3,
      },
    ]);
  });
  it("flags truncation beyond the limit", () => {
    const rows = ["a", "b", "c"].map((id, i) => row(id, 10 * (i + 1), 1));
    expect(volunteerRoster(rows, { weekKnown: true, limit: 2 })).toMatchObject({
      volunteers: [{ membershipId: "c" }, { membershipId: "b" }],
      volunteersTruncated: true,
    });
    expect(
      volunteerRoster(rows, { weekKnown: true, limit: 3 }).volunteersTruncated,
    ).toBe(false);
  });
});

describe("buildProductReport", () => {
  it("omits the roster for aggregate-only readers and includes it for staff", () => {
    expect(buildProductReport(base)).not.toHaveProperty("volunteers");
    expect(buildProductReport(base)).not.toHaveProperty("volunteersTruncated");
    const staff = buildProductReport({
      ...base,
      volunteers: [
        {
          membership_id: "m1",
          minutes: 90,
          approved: 2,
          pending: 1,
          unknown: 1,
          week_minutes: 0,
        },
      ],
    });
    expect(staff.volunteers).toEqual([
      {
        membershipId: "m1",
        approvedMinutes: 90,
        weekApprovedMinutes: 0,
        approvedContributions: 2,
        pendingContributions: 1,
        pendingUnknownDuration: 1,
      },
    ]);
    expect(staff.volunteersTruncated).toBe(false);
    const unknownWeek = buildProductReport({
      ...base,
      weekRange: null,
      week: null,
      volunteers: [{ membership_id: "m1", minutes: 90, approved: 2 }],
    });
    expect(unknownWeek.volunteers?.[0]?.weekApprovedMinutes).toBeNull();
    expect(
      reportCsv(staff).split("\r\n").filter(Boolean),
      "the CSV stays one aggregate row",
    ).toHaveLength(2);
    expect(reportCsv(staff)).not.toMatch(/volunteers|m1/);
  });
  it("builds aggregate totals with null-versus-zero kept distinct", () => {
    const report = buildProductReport(base);
    expect(report).toMatchObject({
      approvedHours: 2.5,
      ledger: {
        approvedMinutes: 150,
        pendingUnknownDuration: 1,
        pendingUnresolvedVolunteer: 1,
      },
      averageAcknowledgmentMinutes: null,
      averageResolutionMinutes: 45,
      unassignedOpenNeeds: 2,
      // No approved time this week is a known zero, not unknown.
      weekApprovedMinutes: 0,
      weekHours: 0,
      weekRange: { from: "2026-11-02", to: "2026-11-08" },
      // Unknown-date exclusions only apply to a dated filter.
      excludedUnknownDate: 0,
    });
  });
  it("reports an unknown week as null when the timezone gives no week", () => {
    const report = buildProductReport({ ...base, weekRange: null, week: null });
    expect(report.weekHours).toBeNull();
    expect(report.weekApprovedMinutes).toBeNull();
    expect(report.weekRange).toBeNull();
  });
  it("omits staff-only fields for aggregate-only readers", () => {
    const report = buildProductReport(base);
    expect(report).not.toHaveProperty("topContributors");
    expect(report).not.toHaveProperty("oldestQueuedReviewAt");
  });
  it("includes staff-only fields when provided", () => {
    const report = buildProductReport({
      ...base,
      query: { from: "2026-11-01" },
      contributors: [{ membership_id: "m1", minutes: 90, approved: 2 }],
      oldestQueued: { oldest: new Date("2026-11-07T09:30:00Z") },
    });
    expect(report.topContributors).toEqual([
      { membershipId: "m1", approvedMinutes: 90, approvedContributions: 2 },
    ]);
    expect(report.oldestQueuedReviewAt).toBe("2026-11-07T09:30:00.000Z");
    expect(report.excludedUnknownDate).toBe(4);
    expect(
      buildProductReport({ ...base, oldestQueued: { oldest: null } })
        .oldestQueuedReviewAt,
    ).toBeNull();
  });
});

describe("reportCsv", () => {
  it("exports one aggregate row whose header names exclude evidence and per-member fields", () => {
    const report = buildProductReport({
      ...base,
      query: { program: '=HYPERLINK("x")', membershipId: "m1" },
      contributors: [{ membership_id: "m1", minutes: 90, approved: 2 }],
      oldestQueued: { oldest: "2026-11-07T09:30:00Z" },
    });
    const text = reportCsv(report);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.split("\r\n")).toHaveLength(3);
    const row = parseCsv(text);
    expect(Object.keys(row)).toEqual([
      "timezone",
      "from",
      "to",
      "program",
      "membershipId",
      "approvedMinutes",
      "approvedContributions",
      "activitiesWithApprovedContributions",
      "pendingContributions",
      "pendingUnknownDuration",
      "pendingUnresolvedVolunteer",
      "approvedHours",
      "openNeeds",
      "resolvedNeeds",
      "averageAcknowledgmentMinutes",
      "averageResolutionMinutes",
      "excludedUnknownDate",
      "weekFrom",
      "weekTo",
      "weekApprovedMinutes",
      "weekHours",
      "unassignedOpenNeeds",
    ]);
    expect(text).not.toMatch(/source|evidence|contributionId|topContributors/i);
    expect(text).not.toContain("2026-11-07");
    expect(row.program).toBe('\'=HYPERLINK("x")');
    expect(row.approvedHours).toBe("2.5");
    expect(row.averageAcknowledgmentMinutes).toBe("");
    expect(row.weekApprovedMinutes).toBe("0");
  });
  it("leaves an unknown week empty rather than zero", () => {
    const row = parseCsv(
      reportCsv(buildProductReport({ ...base, weekRange: null, week: null })),
    );
    expect(row.weekFrom).toBe("");
    expect(row.weekHours).toBe("");
  });
});

describe("volunteerDetail", () => {
  const weekRange = { from: "2026-11-09", to: "2026-11-15" };
  const activity = (
    activity_id: unknown,
    minutes: number,
    approved: number,
    local_date: unknown = "2026-11-10",
    kind: unknown = "Garden",
  ) => ({ activity_id, kind, local_date, minutes, approved });

  it("zero-fills the eight weeks oldest first, ignoring rows outside the window", () => {
    const detail = volunteerDetail({
      membershipId: "m1",
      weekRange,
      weeks: [
        { week_start: "2026-11-09", minutes: 30 },
        { week_start: "2026-10-12", minutes: "45" },
        // Before the window: never folded into the oldest week.
        { week_start: "2026-09-14", minutes: 600 },
        { week_start: null, minutes: 999 },
      ],
      unknownDate: { count: 2 },
      activities: [],
    });
    expect(detail.weeks).toEqual([
      { weekStart: "2026-09-21", approvedMinutes: 0 },
      { weekStart: "2026-09-28", approvedMinutes: 0 },
      { weekStart: "2026-10-05", approvedMinutes: 0 },
      { weekStart: "2026-10-12", approvedMinutes: 45 },
      { weekStart: "2026-10-19", approvedMinutes: 0 },
      { weekStart: "2026-10-26", approvedMinutes: 0 },
      { weekStart: "2026-11-02", approvedMinutes: 0 },
      { weekStart: "2026-11-09", approvedMinutes: 30 },
    ]);
    expect(detail.unknownDateContributions).toBe(2);
    expect(detail.byActivity).toEqual([]);
    expect(detail.byActivityTruncated).toBe(false);
  });
  it("keeps the trend unknown (null), not zeros, when the week is unknown", () => {
    const detail = volunteerDetail({
      membershipId: "m1",
      weekRange: null,
      weeks: [{ week_start: "2026-11-09", minutes: 30 }],
      unknownDate: {},
      activities: [],
    });
    expect(detail.weeks).toBeNull();
    expect(detail.unknownDateContributions).toBe(0);
  });
  it("orders activities by minutes then id, keeps unknown dates and flags the cut", () => {
    const detail = volunteerDetail({
      membershipId: "m1",
      weekRange,
      weeks: [],
      unknownDate: { count: 0 },
      activities: [
        activity("b", 30, 1),
        activity("a", 30, 2, null, "Kitchen shift"),
        activity("c", 90, 1, "2026-10-01"),
        activity(null, 500, 1),
        activity("empty", 0, 0),
      ],
      limit: 2,
    });
    expect(detail.byActivity).toEqual([
      {
        activityId: "c",
        kind: "Garden",
        localDate: "2026-10-01",
        approvedMinutes: 90,
        approvedContributions: 1,
      },
      {
        activityId: "a",
        kind: "Kitchen shift",
        localDate: null,
        approvedMinutes: 30,
        approvedContributions: 2,
      },
    ]);
    expect(detail.byActivityTruncated).toBe(true);
  });
  it("is attached by buildProductReport only when provided", () => {
    expect(buildProductReport(base)).not.toHaveProperty("volunteerDetail");
    const detail = volunteerDetail({
      membershipId: "m1",
      weekRange,
      weeks: [],
      unknownDate: {},
      activities: [],
    });
    expect(
      buildProductReport({ ...base, volunteerDetail: detail }).volunteerDetail,
    ).toEqual(detail);
  });
});

describe("volunteerCsv", () => {
  const v = (
    membershipId: string,
    approvedMinutes: number,
    weekApprovedMinutes: number | null,
  ) => ({
    membershipId,
    approvedMinutes,
    weekApprovedMinutes,
    approvedContributions: approvedMinutes ? 1 : 0,
    pendingContributions: approvedMinutes ? 0 : 1,
    pendingUnknownDuration: 0,
  });
  it("writes a header and one row per volunteer in roster order", () => {
    const text = volunteerCsv(
      [v("m-a", 90, 30), v("m-b", 0, 0)],
      new Map([
        ["m-a", "Ana"],
        ["m-b", "Ben"],
      ]),
    );
    expect(text).toBe(
      [
        '"membershipId","volunteerName","approvedMinutes","approvedHours","weekApprovedMinutes","approvedContributions","pendingContributions","pendingUnknownDuration"',
        '"m-a","Ana","90","1.5","30","1","0","0"',
        '"m-b","Ben","0","0","0","0","1","0"',
        "",
      ].join("\r\n"),
    );
  });
  it("leaves unknown week and former-member name empty, and neutralizes formulas in names", () => {
    const text = volunteerCsv(
      [v("m-a", 60, null), v("m-gone", 30, 0)],
      new Map([["m-a", '=HYPERLINK("x")']]),
    );
    const [, first, second] = text.split("\r\n");
    expect(first).toBe('"m-a","\'=HYPERLINK(""x"")","60","1","","1","0","0"');
    expect(second).toBe('"m-gone","","30","0.5","0","1","0","0"');
  });
  it("is a header alone for an empty roster", () => {
    expect(volunteerCsv([], new Map()).split("\r\n")).toEqual([
      VOLUNTEER_CSV_COLUMNS.map((c) => `"${c}"`).join(","),
      "",
    ]);
  });
});
