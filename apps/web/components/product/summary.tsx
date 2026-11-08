"use client";

import {
  type ProductReport,
  reportQuerySchema,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card as BaseCard, Live } from "../card";
import { Button, Icon, Meter, Select, TextInput } from "../foundation";
import { duration } from "./shared";
import styles from "./summary.module.css";

function Card({ children }: { children: ReactNode }) {
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}
/** Renders a possibly-unknown value; unknown is hatched, never zero. */
function Value({ text }: { text: string }) {
  return text === "Unknown" ? (
    <span className={styles.unknownChip}>Unknown</span>
  ) : (
    text
  );
}
export function Summary({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<ProductReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true);
    void request<ProductReport>(
      `/api/product/reports${query ? `?${query}` : ""}`,
    ).then((result) => {
      if (!live) return;
      if (result.ok) {
        setReport(result.value);
        setError("");
      } else {
        setReport(null);
        setError(errorMessage(result.error.code));
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [query]);
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
      setError("Check the date range and filters.");
      return;
    }
    setError("");
    setQuery(
      new URLSearchParams(
        Object.entries(parsed.data).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ).toString(),
    );
  }
  const s = report?.ledger;
  return (
    <>
      <header className={styles.heading}>
        <span className={styles.eyebrow}>Reporting</span>
        <h1>Summary</h1>
        <p>Only approved contributions count toward recorded time.</p>
      </header>
      <Card>
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
          <div className={styles.sectionHeading}>
            <p>Timezone: {report.timezone}</p>
            <a
              className={styles.csvLink}
              href={`/api/product/reports.csv${query ? `?${query}` : ""}`}
            >
              <Icon name="download" size={16} />
              Download aggregate CSV
            </a>
          </div>
          <div className={styles.metrics}>
            <Card>
              <h2>Approved hours</h2>
              <p className={styles.metricValue}>{report.approvedHours}</p>
              <p>Recorded time</p>
            </Card>
            <Card>
              <h2>Activities with approved contributions</h2>
              <p className={styles.metricValue}>
                {s.activitiesWithApprovedContributions}
              </p>
              <p>Activities in the ledger</p>
            </Card>
            <Card>
              <h2>Open needs</h2>
              <p className={styles.metricValue}>{report.openNeeds}</p>
              <p>{report.resolvedNeeds} resolved</p>
            </Card>
            <Card>
              <h2>Pending contributions</h2>
              <p className={styles.metricValue}>{s.pendingContributions}</p>
              <p>Awaiting complete information</p>
            </Card>
          </div>
          <Card>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Report details</span>
                <h2>At a glance</h2>
              </div>
              <span>Approved ledger and needs</span>
            </div>
            <Meter
              value={s.approvedContributions}
              max={s.approvedContributions + s.pendingContributions}
              className={styles.meter ?? ""}
            />
            <div className={styles.tableWrap}>
              <table className={styles.reportTable}>
                <tbody>
                  <tr>
                    <th scope="row">Approved minutes</th>
                    <td>{s.approvedMinutes}</td>
                  </tr>
                  <tr>
                    <th scope="row">Approved contributions</th>
                    <td>{s.approvedContributions}</td>
                  </tr>
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
        </>
      ) : null}
    </>
  );
}
