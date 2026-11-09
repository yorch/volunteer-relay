"use client";

import {
  type ProductReport,
  reportQuerySchema,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card, Live } from "../card";
import { Button, Icon, Meter, Select, TextInput } from "../foundation";
import { duration } from "./shared";
import styles from "./summary.module.css";
import { VolunteerDetailPanel, VolunteerRoster } from "./volunteer-roster";

export { VolunteerDetailPanel, VolunteerRoster };

const hoursFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});
/** Formats approved hours; unknown (null/absent) stays "Unknown", never 0. */
export function hours(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? hoursFormat.format(value)
    : "Unknown";
}
const updatedVisibleMs = 8000;
/**
 * Loads the report for `query` and refetches it whenever the workspace
 * snapshot version changes (after any successful mutation). Only the newest
 * request may update state, so a slow earlier response never overwrites a
 * newer one. A background refetch keeps the current report on screen and
 * reports `updated` instead of flashing a loading state.
 */
export function useReport(query: string, snapshotVersion: number) {
  const [report, setReport] = useState<ProductReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);
  const latest = useRef(0);
  // The query whose report is currently displayed.
  const shown = useRef<string | null>(null);
  useEffect(() => {
    void snapshotVersion;
    const id = ++latest.current;
    const background = shown.current === query;
    if (!background) setLoading(true);
    void request<ProductReport>(
      `/api/product/reports${query ? `?${query}` : ""}`,
    ).then((result) => {
      if (id !== latest.current) return;
      if (result.ok) {
        setReport(result.value);
        setError("");
        setGeneratedAt(new Date());
        shown.current = query;
        setUpdated(background);
      } else {
        // A failed background refresh keeps the last good report visible.
        if (!background) {
          setReport(null);
          shown.current = null;
        }
        setError(errorMessage(result.error.code));
        setUpdated(false);
      }
      setLoading(false);
    });
    return () => {
      // Invalidate this request when the effect re-runs or unmounts.
      if (latest.current === id) latest.current++;
    };
  }, [query, snapshotVersion]);
  useEffect(() => {
    if (!updated) return;
    const timer = setTimeout(() => setUpdated(false), updatedVisibleMs);
    return () => clearTimeout(timer);
  }, [updated]);
  return { report, error, loading, updated, generatedAt };
}
/** A fixed-height polite status, so announcing an update shifts no layout. */
export function UpdatedStatus({
  updated,
  className,
}: {
  updated: boolean;
  className?: string | undefined;
}) {
  return (
    <p className={`${styles.updated} ${className ?? ""}`} aria-live="polite">
      {updated ? (
        <>
          <Icon name="refresh" size={16} />
          <span>Updated just now</span>
        </>
      ) : null}
    </p>
  );
}

/** Renders a possibly-unknown value; unknown is hatched, never zero. */
function Value({ text }: { text: string }) {
  return text === "Unknown" ? (
    <span className={styles.unknownChip}>Unknown</span>
  ) : (
    text
  );
}
type Ledger = ProductReport["ledger"];
/**
 * Approved vs pending contributions. "Duration unknown" and "volunteer
 * unresolved" are overlapping flags on the pending set (one contribution can
 * carry both), so they are listed beside the bar, never stacked in it.
 */
export function CompositionBar({ ledger }: { ledger?: Ledger | undefined }) {
  if (!ledger) return null;
  const parts = [
    { key: "approved", label: "Approved", n: ledger.approvedContributions },
    { key: "pending", label: "Pending", n: ledger.pendingContributions },
  ] as const;
  const flags = [
    {
      key: "unknown",
      label: "Pending with duration unknown",
      n: ledger.pendingUnknownDuration,
    },
    {
      key: "unresolved",
      label: "Pending with volunteer unresolved",
      n: ledger.pendingUnresolvedVolunteer,
    },
  ] as const;
  const total = parts.reduce((sum, p) => sum + p.n, 0);
  return (
    <div className={styles.composition}>
      <h2 className={styles.compositionTitle}>Where contributions stand</h2>
      {total > 0 ? (
        <span className={styles.compositionBar} aria-hidden="true">
          {parts
            .filter((p) => p.n > 0)
            .map((p) => (
              <span
                key={p.key}
                className={`${styles.segment} ${styles[`seg-${p.key}`]}`}
                style={{ flexGrow: p.n }}
              />
            ))}
        </span>
      ) : (
        <p className={styles.compositionEmpty}>
          No contributions have been recorded yet.
        </p>
      )}
      <ul className={styles.legend}>
        {[...parts, ...flags].map((p) => (
          <li key={p.key}>
            <span
              className={`${styles.swatch} ${styles[`seg-${p.key}`]}`}
              aria-hidden="true"
            />
            <span>
              {p.label}: {p.n}
            </span>
          </li>
        ))}
      </ul>
      <p className={styles.compositionNote}>
        The two “pending with” counts can overlap, so they do not add up to the
        pending total.
      </p>
    </div>
  );
}
/** The staff per-volunteer CSV for the same report filters. */
export function volunteerCsvHref(query: string) {
  const params = new URLSearchParams(query);
  params.set("view", "volunteers");
  return `/api/product/reports.csv?${params.toString()}`;
}
function stamp(value: Date | null, timezone: string) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(value);
  } catch {
    return value.toISOString();
  }
}
export function Summary({
  snapshot,
  snapshotVersion = 0,
}: {
  snapshot: WorkspaceSnapshot;
  snapshotVersion?: number;
}) {
  const [query, setQuery] = useState("");
  const [formError, setFormError] = useState("");
  const {
    report,
    error: loadError,
    loading,
    updated,
    generatedAt,
  } = useReport(query, snapshotVersion);
  const error = formError || loadError;
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const draft = Object.fromEntries(
      ["from", "to", "program", "membershipId"]
        .map((name) => [name, String(f.get(name) || "").trim()])
        .filter(([, value]) => value),
    );
    const parsed = reportQuerySchema.safeParse(draft);
    if (!parsed.success) {
      setFormError("Check the date range and filters.");
      return;
    }
    setFormError("");
    setQuery(
      new URLSearchParams(
        Object.entries(parsed.data).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ).toString(),
    );
  }
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  useEffect(() => {
    try {
      if (window.localStorage.getItem("relay-table-density") === "compact")
        setDensity("compact");
    } catch {
      /* storage unavailable */
    }
  }, []);
  function chooseDensity(next: "comfortable" | "compact") {
    setDensity(next);
    try {
      window.localStorage.setItem("relay-table-density", next);
    } catch {
      /* storage unavailable */
    }
  }
  const s = report?.ledger;
  const q = report?.query ?? {};
  const memberName = (id: string) =>
    snapshot.members.find((m) => m.membershipId === id)?.name ?? "Volunteer";
  const range =
    q.from && q.to
      ? `${q.from} to ${q.to}`
      : q.from
        ? `From ${q.from}`
        : q.to
          ? `Through ${q.to}`
          : "All dates";
  return (
    <div className={styles.printRoot}>
      <header className={styles.heading}>
        <span className={styles.eyebrow}>Reporting</span>
        <h1>Summary</h1>
        <p>Only approved contributions count toward recorded time.</p>
      </header>
      <Card className={`${styles.card} ${styles.noPrint}`}>
        <h2>Filter report</h2>
        <form className={styles.reportFilters} onSubmit={apply}>
          <div className={styles.field}>
            <label htmlFor="report-from">From date</label>
            <TextInput id="report-from" type="date" name="from" />
          </div>
          <div className={styles.field}>
            <label htmlFor="report-to">To date</label>
            <TextInput id="report-to" type="date" name="to" />
          </div>
          <div className={styles.field}>
            <label htmlFor="report-program">Program</label>
            <TextInput id="report-program" name="program" maxLength={100} />
          </div>
          {snapshot.organization.role !== "report-reader" && (
            <div className={styles.field}>
              <label htmlFor="report-volunteer">Volunteer</label>
              <Select id="report-volunteer" name="membershipId">
                <option value="">All volunteers</option>
                {snapshot.members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className={styles.apply}>
            <Button type="submit">Apply filters</Button>
          </div>
        </form>
      </Card>
      <Live kind="alert">{error}</Live>
      <Live kind="polite">{loading ? "Loading report…" : ""}</Live>
      {loading ? null : report && s ? (
        <>
          <div className={styles.printHeader}>
            <p className={styles.printOrg}>{snapshot.organization.name}</p>
            <p className={styles.printTitle}>Volunteer summary report</p>
            <dl className={styles.printFacts}>
              <div>
                <dt>Dates</dt>
                <dd>{range}</dd>
              </div>
              {q.program && (
                <div>
                  <dt>Program</dt>
                  <dd>{q.program}</dd>
                </div>
              )}
              {q.membershipId && (
                <div>
                  <dt>Volunteer</dt>
                  <dd>{memberName(q.membershipId)}</dd>
                </div>
              )}
              <div>
                <dt>Timezone</dt>
                <dd>{report.timezone}</dd>
              </div>
              <div>
                <dt>Generated</dt>
                <dd>{stamp(generatedAt, report.timezone)}</dd>
              </div>
            </dl>
          </div>
          <div className={`${styles.sectionHeading} ${styles.toolbar}`}>
            <div className={styles.toolbarMeta}>
              <p>Timezone: {report.timezone}</p>
              <UpdatedStatus updated={updated} />
            </div>
            <div className={styles.toolbarActions}>
              <Button
                variant="secondary"
                className={styles.printButton ?? ""}
                onClick={() => window.print()}
              >
                <Icon name="reports" size={16} />
                Print report
              </Button>
              <a
                className={styles.csvLink}
                href={`/api/product/reports.csv${query ? `?${query}` : ""}`}
              >
                <Icon name="download" size={16} />
                Download aggregate CSV
              </a>
              {report.volunteers !== undefined && (
                <a className={styles.csvLink} href={volunteerCsvHref(query)}>
                  <Icon name="download" size={16} />
                  Download volunteer CSV
                </a>
              )}
            </div>
          </div>
          <div className={styles.metrics}>
            <Card className={styles.card}>
              <h2>Approved hours</h2>
              <p className={styles.metricValue}>
                <Value text={hours(report.approvedHours)} />
              </p>
              <p>Recorded time</p>
            </Card>
            <Card className={styles.card}>
              <h2>Activities with approved contributions</h2>
              <p className={styles.metricValue}>
                {s.activitiesWithApprovedContributions}
              </p>
              <p>Activities in the ledger</p>
            </Card>
            <Card className={styles.card}>
              <h2>Open needs</h2>
              <p className={styles.metricValue}>{report.openNeeds}</p>
              <p>{report.resolvedNeeds} resolved</p>
            </Card>
            <Card className={styles.card}>
              <h2>Pending contributions</h2>
              <p className={styles.metricValue}>{s.pendingContributions}</p>
              <p>Awaiting complete information</p>
            </Card>
          </div>
          <Card className={`${styles.card} ${styles.avoidBreak}`}>
            <CompositionBar ledger={s} />
          </Card>
          <Card className={`${styles.card} ${styles.avoidBreak}`}>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Report details</span>
                <h2>At a glance</h2>
              </div>
              <div className={styles.density}>
                {(["comfortable", "compact"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={styles.densityButton}
                    aria-pressed={density === d}
                    onClick={() => chooseDensity(d)}
                  >
                    {d === "comfortable" ? "Comfortable" : "Compact"}
                  </button>
                ))}
              </div>
            </div>
            <Meter
              value={s.approvedContributions}
              max={s.approvedContributions + s.pendingContributions}
              className={styles.meter ?? ""}
            />
            <div className={styles.tableWrap}>
              <table
                className={`${styles.reportTable} ${
                  density === "compact" ? styles.compact : ""
                }`}
              >
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Approved minutes</th>
                    <td>{s.approvedMinutes}</td>
                  </tr>
                  <tr>
                    <th scope="row">Approved contributions</th>
                    <td>{s.approvedContributions}</td>
                  </tr>
                  {"weekHours" in report && (
                    <tr>
                      <th scope="row">
                        Approved hours this week
                        {report.weekRange
                          ? ` (${report.weekRange.from} to ${report.weekRange.to})`
                          : ""}
                      </th>
                      <td>
                        <Value text={hours(report.weekHours)} />
                      </td>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">Pending with unknown duration</th>
                    <td>{s.pendingUnknownDuration}</td>
                  </tr>
                  <tr>
                    <th scope="row">Pending with unresolved volunteer</th>
                    <td>{s.pendingUnresolvedVolunteer}</td>
                  </tr>
                  <tr>
                    <th scope="row">Needs</th>
                    <td>
                      {report.openNeeds} open · {report.resolvedNeeds} resolved
                    </td>
                  </tr>
                  {report.unassignedOpenNeeds !== undefined && (
                    <tr>
                      <th scope="row">Open needs without an owner</th>
                      <td>{report.unassignedOpenNeeds}</td>
                    </tr>
                  )}
                  <tr>
                    <th scope="row">Average acknowledgment time</th>
                    <td>
                      <Value
                        text={duration(report.averageAcknowledgmentMinutes)}
                      />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Average resolution time</th>
                    <td>
                      <Value
                        text={duration(report.averageResolutionMinutes ?? null)}
                      />
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Unknown dates excluded</th>
                    <td>{report.excludedUnknownDate}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          {q.membershipId && report.volunteerDetail && (
            <VolunteerDetailPanel
              detail={report.volunteerDetail}
              name={memberName(q.membershipId)}
              from={q.from}
              to={q.to}
              program={q.program}
            />
          )}
          {report.volunteers !== undefined && (
            <VolunteerRoster
              volunteers={report.volunteers}
              truncated={report.volunteersTruncated === true}
              members={snapshot.members}
              from={q.from}
              to={q.to}
              weekKnown={report.weekRange != null}
              scoped={Boolean(q.from || q.to || q.program)}
              volunteerFiltered={Boolean(q.membershipId)}
            />
          )}
          {/* The roster lists every contributing member in the same order,
              so the separate top-five list only remains for older servers. */}
          {report.volunteers === undefined &&
            report.topContributors &&
            report.topContributors.length > 0 && (
              <Card className={`${styles.card} ${styles.avoidBreak}`}>
                <div className={styles.sectionHeading}>
                  <div>
                    <span className={styles.eyebrow}>Approved time</span>
                    <h2>Top contributors</h2>
                  </div>
                  <span>For the filtered dates</span>
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.reportTable}>
                    <thead>
                      <tr>
                        <th scope="col">Volunteer</th>
                        <th scope="col">Approved hours</th>
                        <th scope="col">Contributions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.topContributors.map((c) => (
                        <tr key={c.membershipId}>
                          <th scope="row">{memberName(c.membershipId)}</th>
                          <td>{hours(c.approvedMinutes / 60)}</td>
                          <td>{c.approvedContributions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
        </>
      ) : null}
    </div>
  );
}
