"use client";

import type {
  ReportVolunteer,
  ReportVolunteerDetail,
  WorkspaceSnapshot,
} from "@relay/contracts";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Card, Live } from "../card";
import { Button, Select, TextInput } from "../foundation";
import { ledgerHref } from "./ledger";
import {
  filterRoster,
  initialDirection,
  paginate,
  parseRosterState,
  ROSTER_SEARCH_MAX,
  type RosterSortDir,
  type RosterSortKey,
  type RosterState,
  rosterRows,
  rosterSearch,
  rosterSortKeys,
  sortRoster,
} from "./roster-view";
import styles from "./summary.module.css";

const hoursFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
/** Approved hours with a unit; a known zero is "0 h", unknown stays Unknown. */
function hoursCell(minutes: number | null) {
  return minutes === null ? (
    <span className={styles.unknownChip}>Unknown</span>
  ) : (
    `${hoursFormat.format(minutes / 60)} h`
  );
}

const columns: Record<RosterSortKey, string> = {
  name: "Volunteer",
  approved: "Approved hours",
  week: "This week",
  contributions: "Approved contributions",
  pending: "Pending",
};
const directionWords = (key: RosterSortKey, dir: RosterSortDir) =>
  key === "name"
    ? dir === "asc"
      ? "A to Z"
      : "Z to A"
    : dir === "asc"
      ? "low to high"
      : "high to low";
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

function currentSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * Staff-only volunteer hours roster with client-side search, sort and
 * pagination over the rows the server returned. Pending is a count of
 * contributions, never time. All matching rows are rendered so print shows
 * every match; rows outside the current page are hidden on screen only.
 */
export function VolunteerRoster({
  volunteers,
  truncated,
  members,
  from,
  to,
  weekKnown = true,
  scoped = false,
  volunteerFiltered = false,
}: {
  volunteers: readonly ReportVolunteer[];
  truncated: boolean;
  members: WorkspaceSnapshot["members"];
  from?: string | undefined;
  to?: string | undefined;
  /** False when the report week is unknown (appended members stay Unknown). */
  weekKnown?: boolean;
  /** True when a date or program filter narrows the report. */
  scoped?: boolean;
  /** True when the report is filtered to one volunteer. */
  volunteerFiltered?: boolean;
}) {
  const ids = useId();
  const searchId = `${ids}-search`;
  const sortId = `${ids}-sort`;
  // The workspace renders client-side only, so the URL is readable on first
  // render; back/forward navigation re-reads it.
  const [state, setState] = useState<RosterState>(() =>
    parseRosterState(currentSearch()),
  );
  const [showEmpty, setShowEmpty] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const sync = () => setState(parseRosterState(currentSearch()));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  // Members outside the roster are only knowable when it is complete and
  // not narrowed to one volunteer.
  const canShowEmpty = !truncated && !volunteerFiltered;
  const rows = rosterRows(volunteers, members, {
    includeEmpty: canShowEmpty && showEmpty,
    weekKnown,
  });
  const matching = sortRoster(
    filterRoster(rows, state.q),
    state.sort,
    state.dir,
  );
  const pages = paginate(matching, state.page);
  const emptyLabel = scoped
    ? "No contributions for these filters"
    : "No contributions yet";

  function update(next: RosterState, announce: boolean) {
    setState(next);
    try {
      const search = rosterSearch(next, window.location.search);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${search}${window.location.hash}`,
      );
    } catch {
      /* history unavailable */
    }
    if (!announce) return;
    const total = sortRoster(
      filterRoster(rows, next.q),
      next.sort,
      next.dir,
    ).length;
    const shown = paginate(new Array(total).fill(0), next.page);
    setAnnouncement(
      total === 0
        ? "No volunteers match the search."
        : `${plural(total, "volunteer", "volunteers")}${next.q.trim() ? " match" : ""}. Sorted by ${columns[next.sort].toLowerCase()}, ${directionWords(next.sort, next.dir)}. Showing ${shown.start + 1} to ${shown.end}.`,
    );
  }
  function sortBy(key: RosterSortKey) {
    const dir =
      state.sort === key
        ? state.dir === "asc"
          ? "desc"
          : "asc"
        : initialDirection(key);
    update({ ...state, sort: key, dir, page: 1 }, true);
  }
  const sortValue = `${state.sort}-${state.dir}`;

  return (
    <Card className={`${styles.card} ${styles.rosterCard}`}>
      <section aria-labelledby="volunteer-roster-title">
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Approved time</span>
            <h2 id="volunteer-roster-title">Volunteers</h2>
          </div>
          <span>
            {volunteers.length}{" "}
            {volunteers.length === 1 ? "volunteer" : "volunteers"} with
            contributions
          </span>
        </div>
        {truncated && (
          <p className={styles.rosterNotice}>
            <strong>Truncated:</strong> showing the first {volunteers.length}{" "}
            volunteers by approved time. Narrow the filters to see the rest.
          </p>
        )}
        {volunteers.length === 0 && !(canShowEmpty && showEmpty) ? (
          <p className={styles.compositionEmpty}>
            No volunteer has contributions for these filters yet.
          </p>
        ) : null}
        <div className={styles.rosterControls}>
          <div className={styles.field}>
            <label htmlFor={searchId}>Search volunteers</label>
            <TextInput
              id={searchId}
              type="search"
              autoComplete="off"
              maxLength={ROSTER_SEARCH_MAX}
              value={state.q}
              onChange={(e) =>
                update({ ...state, q: e.currentTarget.value, page: 1 }, true)
              }
            />
          </div>
          <div className={`${styles.field} ${styles.rosterSortField}`}>
            <label htmlFor={sortId}>Sort by</label>
            <Select
              id={sortId}
              value={sortValue}
              onChange={(e) => {
                const [key, dir] = e.currentTarget.value.split("-");
                const k = rosterSortKeys.find((s) => s === key);
                if (k && (dir === "asc" || dir === "desc"))
                  update({ ...state, sort: k, dir, page: 1 }, true);
              }}
            >
              {rosterSortKeys.flatMap((k) =>
                (["desc", "asc"] as const).map((d) => (
                  <option key={`${k}-${d}`} value={`${k}-${d}`}>
                    {columns[k]} ({directionWords(k, d)})
                  </option>
                )),
              )}
            </Select>
          </div>
          {canShowEmpty && (
            <label className={styles.rosterToggle}>
              <input
                type="checkbox"
                checked={showEmpty}
                onChange={(e) => {
                  setShowEmpty(e.currentTarget.checked);
                  update({ ...state, page: 1 }, false);
                }}
              />
              Show members with no contributions
            </label>
          )}
        </div>
        <Live kind="polite">{announcement}</Live>
        {rows.length > 0 && matching.length === 0 ? (
          <p className={styles.compositionEmpty}>
            No volunteers match “{state.q.trim()}”.
          </p>
        ) : null}
        {matching.length > 0 && (
          <>
            <div className={`${styles.tableWrap} ${styles.rosterWrap}`}>
              <table className={`${styles.reportTable} ${styles.rosterTable}`}>
                <caption className={styles.visuallyHidden}>
                  Approved hours, this week's hours and pending contributions
                  for each volunteer, sorted by{" "}
                  {columns[state.sort].toLowerCase()},{" "}
                  {directionWords(state.sort, state.dir)}
                </caption>
                <thead>
                  <tr>
                    {rosterSortKeys.map((k) => (
                      <th
                        key={k}
                        scope="col"
                        aria-sort={
                          state.sort === k
                            ? state.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          className={styles.sortButton}
                          onClick={() => sortBy(k)}
                        >
                          {columns[k]}
                          <span aria-hidden="true" className={styles.sortMark}>
                            {state.sort === k
                              ? state.dir === "asc"
                                ? "▲"
                                : "▼"
                              : "↕"}
                          </span>
                        </button>
                      </th>
                    ))}
                    <th scope="col" className={styles.rosterLinkCol}>
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matching.map((v, index) => {
                    const onPage = index >= pages.start && index < pages.end;
                    return (
                      <tr
                        key={v.membershipId}
                        className={onPage ? undefined : styles.offPage}
                      >
                        <th scope="row">
                          <span className={styles.rosterName}>
                            {v.name}
                            {v.noContributions && (
                              <span className={styles.rosterNote}>
                                {emptyLabel}
                              </span>
                            )}
                          </span>
                        </th>
                        <td data-label="Approved hours">
                          {hoursCell(v.approvedMinutes)}
                        </td>
                        <td data-label="This week">
                          {hoursCell(v.weekApprovedMinutes)}
                        </td>
                        <td data-label="Approved contributions">
                          {v.approvedContributions}
                        </td>
                        <td data-label="Pending">
                          <span>
                            {v.pendingContributions}
                            {v.pendingUnknownDuration > 0 && (
                              <span className={styles.rosterNote}>
                                {v.pendingUnknownDuration} unknown duration
                              </span>
                            )}
                          </span>
                        </td>
                        <td
                          data-label="Details"
                          className={styles.rosterLinkCol}
                        >
                          {v.noContributions ? (
                            <span className={styles.rosterNote}>
                              {emptyLabel}
                            </span>
                          ) : (
                            <Link
                              className={styles.rosterLink}
                              href={ledgerHref({
                                membership: v.membershipId,
                                ...(from ? { from } : {}),
                                ...(to ? { to } : {}),
                              })}
                            >
                              View contributions
                              <span className={styles.visuallyHidden}>
                                {" "}
                                for {v.name}
                              </span>
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className={styles.pager} aria-label="Volunteer pages">
              <p className={styles.pagerStatus}>
                Showing {pages.start + 1}–{pages.end} of {pages.total}
              </p>
              <div className={styles.pagerButtons}>
                <Button
                  variant="secondary"
                  disabled={pages.page <= 1}
                  onClick={() =>
                    update({ ...state, page: pages.page - 1 }, true)
                  }
                >
                  Previous page
                </Button>
                <Button
                  variant="secondary"
                  disabled={pages.page >= pages.pageCount}
                  onClick={() =>
                    update({ ...state, page: pages.page + 1 }, true)
                  }
                >
                  Next page
                </Button>
              </div>
            </nav>
            <p className={styles.printOnly}>
              {plural(pages.total, "volunteer", "volunteers")} listed
              {state.q.trim() ? ` matching “${state.q.trim()}”` : ""}.
            </p>
          </>
        )}
      </section>
    </Card>
  );
}

const weekFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const weekLabel = (weekStart: string) =>
  weekFormat.format(new Date(`${weekStart}T00:00:00Z`));

/**
 * Staff detail for the volunteer filter: an 8-week approved-hours bar chart
 * with an equivalent data table, and approved time by activity.
 */
export function VolunteerDetailPanel({
  detail,
  name,
  from,
  to,
  program,
}: {
  detail: ReportVolunteerDetail;
  name: string;
  from?: string | undefined;
  to?: string | undefined;
  program?: string | undefined;
}) {
  const weeks = detail.weeks;
  const max = weeks ? Math.max(0, ...weeks.map((w) => w.approvedMinutes)) : 0;
  const total = weeks ? weeks.reduce((s, w) => s + w.approvedMinutes, 0) : 0;
  const scope = [
    from && to
      ? `${from} to ${to}`
      : from
        ? `from ${from}`
        : to
          ? `through ${to}`
          : "",
    program ? `program ${program}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <Card className={`${styles.card} ${styles.detailCard}`}>
      <section aria-labelledby="volunteer-detail-title">
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Volunteer detail</span>
            <h2 id="volunteer-detail-title">{name}</h2>
          </div>
        </div>
        <h3 className={styles.detailHeading}>
          Approved hours, last {weeks?.length ?? 8} weeks
        </h3>
        {weeks === null ? (
          <p className={styles.compositionEmpty}>
            The weekly trend is unknown: the organization timezone gives no
            current week.
          </p>
        ) : (
          <>
            <p className={styles.compositionNote}>
              {total === 0
                ? "No approved time in these weeks."
                : `${hoursFormat.format(total / 60)} h approved across these weeks.`}{" "}
              The weekly trend keeps the program filter but ignores the date
              range.
            </p>
            <div className={styles.weekChart} aria-hidden="true">
              {weeks.map((w, i) => {
                const pct = max > 0 ? (w.approvedMinutes / max) * 100 : 0;
                const value = `${hoursFormat.format(w.approvedMinutes / 60)} h`;
                const current = i === weeks.length - 1;
                return (
                  <div
                    key={w.weekStart}
                    className={styles.weekColumn}
                    title={`Week of ${weekLabel(w.weekStart)}: ${value}`}
                  >
                    <span className={styles.weekValue}>{value}</span>
                    <span className={styles.weekTrack}>
                      {w.approvedMinutes > 0 && (
                        <span
                          className={styles.weekBar}
                          style={{ height: `${Math.max(pct, 2)}%` }}
                        />
                      )}
                    </span>
                    <span className={styles.weekLabel}>
                      {weekLabel(w.weekStart)}
                      {current && (
                        <span className={styles.weekCurrent}>This week</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={styles.visuallyHidden}>
              <table>
                <caption>
                  Approved hours per week for {name}, oldest first
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Week starting</th>
                    <th scope="col">Approved hours</th>
                  </tr>
                </thead>
                <tbody>
                  {weeks.map((w, i) => (
                    <tr key={w.weekStart}>
                      <th scope="row">
                        {w.weekStart}
                        {i === weeks.length - 1 ? " (this week)" : ""}
                      </th>
                      <td>{hoursFormat.format(w.approvedMinutes / 60)} h</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {detail.unknownDateContributions > 0 && (
          <p className={styles.compositionNote}>
            {plural(
              detail.unknownDateContributions,
              "approved contribution has",
              "approved contributions have",
            )}{" "}
            an unknown date and{" "}
            {detail.unknownDateContributions === 1 ? "is" : "are"} not shown in
            any week.
          </p>
        )}
        <h3 className={styles.detailHeading}>By activity</h3>
        {scope && (
          <p className={styles.compositionNote}>Filtered to {scope}.</p>
        )}
        {detail.byActivityTruncated && (
          <p className={styles.rosterNotice}>
            <strong>Truncated:</strong> showing the {detail.byActivity.length}{" "}
            activities with the most approved time.
          </p>
        )}
        {detail.byActivity.length === 0 ? (
          <p className={styles.compositionEmpty}>
            No approved contributions for these filters.
          </p>
        ) : (
          <div className={`${styles.tableWrap} ${styles.rosterWrap}`}>
            <table className={`${styles.reportTable} ${styles.rosterTable}`}>
              <caption className={styles.visuallyHidden}>
                Approved time by activity for {name}, most time first
              </caption>
              <thead>
                <tr>
                  <th scope="col">Activity</th>
                  <th scope="col">Date</th>
                  <th scope="col">Approved hours</th>
                  <th scope="col">Contributions</th>
                  <th scope="col" className={styles.rosterLinkCol}>
                    Details
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.byActivity.map((a) => {
                  const label = a.kind || "Activity";
                  const date = a.localDate ?? "Date unknown";
                  return (
                    <tr key={a.activityId}>
                      <th scope="row">{label}</th>
                      <td data-label="Date">
                        {a.localDate ?? (
                          <span className={styles.unknownChip}>
                            Date unknown
                          </span>
                        )}
                      </td>
                      <td data-label="Approved hours">
                        {hoursCell(a.approvedMinutes)}
                      </td>
                      <td data-label="Contributions">
                        {a.approvedContributions}
                      </td>
                      <td data-label="Details" className={styles.rosterLinkCol}>
                        <Link
                          className={styles.rosterLink}
                          href={ledgerHref({
                            membership: detail.membershipId,
                            status: "approved",
                            ...(a.localDate
                              ? { from: a.localDate, to: a.localDate }
                              : {}),
                          })}
                        >
                          View in ledger
                          <span className={styles.visuallyHidden}>
                            {" "}
                            for {label}, {date}
                          </span>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Card>
  );
}
