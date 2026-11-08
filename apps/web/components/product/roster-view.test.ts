import { describe, expect, it } from "vitest";
import {
  defaultRosterState,
  FORMER_MEMBER,
  filterRoster,
  foldName,
  paginate,
  parseRosterState,
  type RosterRow,
  rosterRows,
  rosterSearch,
  sortRoster,
} from "./roster-view.ts";

// Synthetic members and minutes only.
const volunteer = (
  membershipId: string,
  approvedMinutes: number,
  weekApprovedMinutes: number | null,
  approvedContributions = 1,
  pendingContributions = 0,
) => ({
  membershipId,
  approvedMinutes,
  weekApprovedMinutes,
  approvedContributions,
  pendingContributions,
  pendingUnknownDuration: 0,
});
const row = (
  membershipId: string,
  name: string,
  approvedMinutes: number,
  weekApprovedMinutes: number | null,
): RosterRow => ({
  ...volunteer(membershipId, approvedMinutes, weekApprovedMinutes),
  name,
  noContributions: false,
});
const ids = (rows: readonly RosterRow[]) => rows.map((r) => r.membershipId);

describe("roster URL state", () => {
  it("defaults to approved hours descending on page 1", () => {
    expect(parseRosterState("")).toEqual(defaultRosterState);
    expect(defaultRosterState).toEqual({
      q: "",
      sort: "approved",
      dir: "desc",
      page: 1,
    });
  });
  it("reads search, sort and page", () => {
    expect(
      parseRosterState("?vq=%20Jos%C3%A9%20&vsort=name-asc&vpage=3"),
    ).toEqual({ q: "José", sort: "name", dir: "asc", page: 3 });
  });
  it.each([
    "?vsort=salary-desc",
    "?vsort=name",
    "?vsort=name-up",
    "?vpage=0",
    "?vpage=-2",
    "?vpage=1.5",
    "?vpage=abc",
    "?vpage=99999",
    `?vq=${"x".repeat(101)}`,
  ])("ignores the invalid value in %s", (search) => {
    expect(parseRosterState(search)).toEqual(defaultRosterState);
  });
  it("writes only non-default values and keeps unrelated parameters", () => {
    expect(rosterSearch(defaultRosterState, "?vq=old&vpage=4")).toBe("");
    expect(
      rosterSearch(
        { q: "bea", sort: "week", dir: "asc", page: 2 },
        "?tab=x&vsort=name-asc",
      ),
    ).toBe("?tab=x&vq=bea&vsort=week-asc&vpage=2");
  });
});

describe("foldName and filterRoster", () => {
  it("matches names case- and diacritic-insensitively", () => {
    expect(foldName("  ZOË Ångström ")).toBe("zoe angstrom");
    const rows = [
      row("m1", "José Núñez", 10, 0),
      row("m2", "Bea", 20, 0),
      row("m3", "JOSEFA", 5, 0),
    ];
    expect(ids(filterRoster(rows, "jose"))).toEqual(["m1", "m3"]);
    expect(ids(filterRoster(rows, "NUNEZ"))).toEqual(["m1"]);
    expect(ids(filterRoster(rows, "  "))).toEqual(["m1", "m2", "m3"]);
    expect(filterRoster(rows, "zed")).toEqual([]);
  });
});

describe("sortRoster", () => {
  const rows = [
    row("m-c", "Cy", 60, null),
    row("m-a2", "Ana", 30, 30),
    row("m-b", "bo", 90, 0),
    row("m-a1", "ana", 30, 15),
  ];
  it("sorts approved minutes either way with a name-then-id tie-break", () => {
    expect(ids(sortRoster(rows, "approved", "desc"))).toEqual([
      "m-b",
      "m-c",
      "m-a1",
      "m-a2",
    ]);
    expect(ids(sortRoster(rows, "approved", "asc"))).toEqual([
      "m-a1",
      "m-a2",
      "m-c",
      "m-b",
    ]);
  });
  it("sorts names case-insensitively, then by id", () => {
    expect(ids(sortRoster(rows, "name", "asc"))).toEqual([
      "m-a1",
      "m-a2",
      "m-b",
      "m-c",
    ]);
    expect(ids(sortRoster(rows, "name", "desc"))).toEqual([
      "m-c",
      "m-b",
      "m-a1",
      "m-a2",
    ]);
  });
  it("puts an unknown week last in both directions and never treats it as 0", () => {
    expect(ids(sortRoster(rows, "week", "asc"))).toEqual([
      "m-b",
      "m-a1",
      "m-a2",
      "m-c",
    ]);
    expect(ids(sortRoster(rows, "week", "desc"))).toEqual([
      "m-a2",
      "m-a1",
      "m-b",
      "m-c",
    ]);
  });
  it("does not mutate its input", () => {
    const before = ids(rows);
    sortRoster(rows, "name", "asc");
    expect(ids(rows)).toEqual(before);
  });
});

describe("rosterRows", () => {
  const members = [
    { membershipId: "m1", name: "Alex" },
    { membershipId: "m2", name: "Bea" },
  ];
  it("names former members and appends known-zero members only on request", () => {
    const volunteers = [volunteer("m1", 30, 30), volunteer("gone", 15, 0)];
    expect(
      rosterRows(volunteers, members, {
        includeEmpty: false,
        weekKnown: true,
      }).map((r) => r.name),
    ).toEqual(["Alex", FORMER_MEMBER]);
    const all = rosterRows(volunteers, members, {
      includeEmpty: true,
      weekKnown: true,
    });
    expect(all).toHaveLength(3);
    expect(all[2]).toEqual({
      membershipId: "m2",
      name: "Bea",
      approvedMinutes: 0,
      weekApprovedMinutes: 0,
      approvedContributions: 0,
      pendingContributions: 0,
      pendingUnknownDuration: 0,
      noContributions: true,
    });
  });
  it("keeps the week unknown for appended members when the report week is unknown", () => {
    const [, appended] = rosterRows([volunteer("m1", 30, null)], members, {
      includeEmpty: true,
      weekKnown: false,
    });
    expect(appended?.weekApprovedMinutes).toBeNull();
    expect(appended?.approvedMinutes).toBe(0);
  });
});

describe("paginate", () => {
  const list = Array.from({ length: 60 }, (_, i) => i);
  it("pages by 25 and clamps out-of-range pages", () => {
    expect(paginate(list, 1)).toEqual({
      page: 1,
      pageCount: 3,
      start: 0,
      end: 25,
      total: 60,
    });
    expect(paginate(list, 3)).toMatchObject({ page: 3, start: 50, end: 60 });
    expect(paginate(list, 9)).toMatchObject({ page: 3, start: 50 });
    expect(paginate(list, 0)).toMatchObject({ page: 1, start: 0 });
    expect(paginate([], 4)).toEqual({
      page: 1,
      pageCount: 1,
      start: 0,
      end: 0,
      total: 0,
    });
  });
});
