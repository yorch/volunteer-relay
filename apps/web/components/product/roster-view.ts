import type { ReportVolunteer, WorkspaceSnapshot } from "@relay/contracts";

/**
 * Client-side search, sort and pagination over the staff volunteer roster
 * (at most REPORT_VOLUNTEERS_LIMIT rows already returned by the server). The
 * state lives in the URL query (`vq`, `vsort`, `vpage`) so it survives a
 * reload and can be linked; malformed values fall back to the defaults.
 */
export const rosterSortKeys = [
  "name",
  "approved",
  "week",
  "contributions",
  "pending",
] as const;
export type RosterSortKey = (typeof rosterSortKeys)[number];
export type RosterSortDir = "asc" | "desc";
export interface RosterState {
  q: string;
  sort: RosterSortKey;
  dir: RosterSortDir;
  page: number;
}
export const ROSTER_PAGE_SIZE = 25;
export const ROSTER_SEARCH_MAX = 100;
export const defaultRosterState: RosterState = {
  q: "",
  sort: "approved",
  dir: "desc",
  page: 1,
};
/** The direction a column starts in when it is first chosen. */
export const initialDirection = (key: RosterSortKey): RosterSortDir =>
  key === "name" ? "asc" : "desc";

const MAX_PAGE = 1000;

export function parseRosterState(search: string): RosterState {
  const params = new URLSearchParams(search);
  const state = { ...defaultRosterState };
  const q = params.get("vq")?.trim();
  if (q && q.length <= ROSTER_SEARCH_MAX) state.q = q;
  const sort = /^([a-z]+)-(asc|desc)$/.exec(params.get("vsort") ?? "");
  const key = rosterSortKeys.find((k) => k === sort?.[1]);
  if (sort && key) {
    state.sort = key;
    state.dir = sort[2] as RosterSortDir;
  }
  const page = params.get("vpage");
  if (page && /^[1-9]\d{0,3}$/.test(page) && Number(page) <= MAX_PAGE)
    state.page = Number(page);
  return state;
}

/**
 * Writes the roster state into `search`, keeping unrelated parameters and
 * omitting defaults so a plain Summary URL stays clean.
 */
export function rosterSearch(state: RosterState, search: string) {
  const params = new URLSearchParams(search);
  for (const name of ["vq", "vsort", "vpage"]) params.delete(name);
  const q = state.q.trim();
  if (q) params.set("vq", q.slice(0, ROSTER_SEARCH_MAX));
  if (
    state.sort !== defaultRosterState.sort ||
    state.dir !== defaultRosterState.dir
  )
    params.set("vsort", `${state.sort}-${state.dir}`);
  if (state.page > 1) params.set("vpage", String(state.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Case- and diacritic-insensitive form for matching names. */
export function foldName(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .trim();
}

export interface RosterRow extends ReportVolunteer {
  name: string;
  /** A current member with no contribution in scope; their zero is known. */
  noContributions: boolean;
}

export const FORMER_MEMBER = "Former member";

/**
 * Joins the roster with member names. With `includeEmpty`, current members
 * absent from the roster are appended as known zeros; their week figure is
 * a known zero only when the report week itself is known.
 */
export function rosterRows(
  volunteers: readonly ReportVolunteer[],
  members: WorkspaceSnapshot["members"],
  options: { includeEmpty: boolean; weekKnown: boolean },
): RosterRow[] {
  const names = new Map(members.map((m) => [m.membershipId, m.name]));
  const rows: RosterRow[] = volunteers.map((v) => ({
    ...v,
    name: names.get(v.membershipId) ?? FORMER_MEMBER,
    noContributions: false,
  }));
  if (!options.includeEmpty) return rows;
  const listed = new Set(volunteers.map((v) => v.membershipId));
  for (const m of members) {
    if (listed.has(m.membershipId)) continue;
    listed.add(m.membershipId);
    rows.push({
      membershipId: m.membershipId,
      name: m.name,
      approvedMinutes: 0,
      weekApprovedMinutes: options.weekKnown ? 0 : null,
      approvedContributions: 0,
      pendingContributions: 0,
      pendingUnknownDuration: 0,
      noContributions: true,
    });
  }
  return rows;
}

export function filterRoster(rows: readonly RosterRow[], q: string) {
  const needle = foldName(q);
  return needle
    ? rows.filter((r) => foldName(r.name).includes(needle))
    : [...rows];
}

const collator = new Intl.Collator("en-US", { sensitivity: "base" });
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const numeric: Record<
  Exclude<RosterSortKey, "name">,
  (r: RosterRow) => number | null
> = {
  approved: (r) => r.approvedMinutes,
  week: (r) => r.weekApprovedMinutes,
  contributions: (r) => r.approvedContributions,
  pending: (r) => r.pendingContributions,
};

/**
 * Sorts by the chosen column. Unknown (null) values sort last in either
 * direction and are never treated as 0. Ties break by name, then membership
 * id, both ascending, so the order is stable and deterministic.
 */
export function sortRoster(
  rows: readonly RosterRow[],
  sort: RosterSortKey,
  dir: RosterSortDir,
) {
  const sign = dir === "asc" ? 1 : -1;
  const tie = (a: RosterRow, b: RosterRow) =>
    collator.compare(a.name, b.name) ||
    byCodeUnit(a.membershipId, b.membershipId);
  return [...rows].sort((a, b) => {
    if (sort === "name")
      return sign * collator.compare(a.name, b.name) || tie(a, b);
    const va = numeric[sort](a),
      vb = numeric[sort](b);
    if (va === null || vb === null) {
      if (va === vb) return tie(a, b);
      return va === null ? 1 : -1;
    }
    return sign * (va - vb) || tie(a, b);
  });
}

/** Clamps the page into range; an empty list still has page 1. */
export function paginate<T>(rows: readonly T[], page: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / ROSTER_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const start = (current - 1) * ROSTER_PAGE_SIZE;
  const end = Math.min(rows.length, start + ROSTER_PAGE_SIZE);
  return { page: current, pageCount, start, end, total: rows.length };
}
