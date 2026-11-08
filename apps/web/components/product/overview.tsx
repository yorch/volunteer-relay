"use client";

import type { WorkspaceSnapshot } from "@relay/contracts";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  Badge,
  EmptyState,
  Icon,
  type IconName,
  Skeleton,
} from "../foundation";
import { ledgerHref } from "./ledger";
import styles from "./overview.module.css";
import { date } from "./shared";
import { hours, UpdatedStatus, useReport } from "./summary";

function Card({
  children,
  className = "",
  busy,
  label,
}: {
  children: ReactNode;
  className?: string;
  busy?: boolean;
  label?: string;
}) {
  return (
    <section
      className={`${styles.card} ${className}`}
      {...(busy ? { "aria-busy": true } : {})}
      {...(label ? { "aria-label": label } : {})}
    >
      {children}
    </section>
  );
}
function Tile({
  icon,
  tone,
  label,
  busy,
  children,
}: {
  icon: IconName;
  tone: "teal" | "clay" | "amber" | "blue";
  label: string;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className={`${styles.tile} ${styles[tone]}`} busy={busy ?? false}>
      <div className={styles.tileHead}>
        <span className={styles.chip} aria-hidden="true">
          <Icon name={icon} size={20} />
        </span>
        <span className={styles.eyebrow}>{label}</span>
      </div>
      {children}
    </Card>
  );
}
/**
 * A metric whose number links to its evidence. The visible value is its own
 * element; `context` completes the link's accessible name.
 */
function MetricLink({
  href,
  value,
  context,
}: {
  href: string;
  value: ReactNode;
  context: string;
}) {
  return (
    <Link className={styles.metricLink} href={href as Route}>
      <span className={styles.metricValue}>{value}</span>
      <span className={styles.visuallyHidden}>{context}</span>
    </Link>
  );
}
function Unknown() {
  return <span className={styles.unknownChip}>Unknown</span>;
}
function age(iso: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 48) return `${h} hr`;
  return `${Math.floor(h / 24)} days`;
}
function Attention({
  href,
  label,
  value,
  tone,
}: {
  href: string;
  label: string;
  value: number | string | null | undefined;
  tone: "warn" | "info" | "quiet";
}) {
  const known = value !== null && value !== undefined;
  return (
    <li>
      <Link
        className={`${styles.attention} ${
          tone === "warn"
            ? styles.sevWarn
            : tone === "info"
              ? styles.sevInfo
              : styles.sevQuiet
        }`}
        href={href as Route}
      >
        <span className={styles.attentionValue}>
          {known ? value : <Unknown />}
        </span>
        <span className={styles.attentionLabel}>{label}</span>
      </Link>
    </li>
  );
}
export function Overview({
  snapshot,
  snapshotVersion = 0,
}: {
  snapshot: WorkspaceSnapshot;
  snapshotVersion?: number;
}) {
  const { report, error, loading, updated } = useReport("", snapshotVersion);
  const reportError = !report && !!error;
  const openNeeds = snapshot.needs
    .filter((n) => ["new", "assigned", "acknowledged"].includes(n.status))
    .sort(
      (a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"),
    );
  const failed = snapshot.sources.filter((s) => s.status === "failed").length;
  const urgent = openNeeds.filter((n) => n.urgency === "urgent").length;
  const reportLoading = !report && loading;
  const reportNote = (ready: string) =>
    reportError ? "Report unavailable" : report ? ready : "Loading report…";
  const reportValue = (value: ReactNode) =>
    report ? value : reportLoading ? <Skeleton width={96} height={40} /> : "—";
  const ledger = report?.ledger;
  const week = report?.weekRange;
  const memberName = (id: string) =>
    snapshot.members.find((m) => m.membershipId === id)?.name ?? "Volunteer";
  const now = Date.now();
  return (
    <>
      <div className={styles.pageHeader}>
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>Your workspace</span>
          <h1>Overview</h1>
          <p>Here's what needs your attention today.</p>
          <UpdatedStatus updated={updated} />
        </div>
        <Link className={styles.primaryLink} href="/workspace/inbox">
          Review updates <Icon name="arrowRight" size={16} />
        </Link>
      </div>
      <div className={styles.metrics}>
        <Tile icon="inbox" tone="amber" label="Awaiting review">
          <MetricLink
            href="/workspace/inbox"
            value={snapshot.queue.length}
            context=" updates awaiting review, open the inbox"
          />
          <p className={styles.metricNote}>Updates ready for a decision</p>
          <Link href="/workspace/inbox">Open inbox</Link>
        </Tile>
        <Tile icon="needs" tone="clay" label="Open needs">
          <MetricLink
            href="/workspace/needs"
            value={openNeeds.length}
            context=" open needs, view the needs board"
          />
          <p className={styles.metricNote}>Needs being tracked</p>
          <Link href="/workspace/needs">View needs</Link>
        </Tile>
        <Tile
          icon="calendar"
          tone="blue"
          label="This week"
          busy={reportLoading}
        >
          {report ? (
            report.weekHours === null || report.weekHours === undefined ? (
              <p className={styles.metricValue}>
                <Unknown />
              </p>
            ) : (
              <MetricLink
                href={ledgerHref({
                  status: "approved",
                  ...(week ? { from: week.from, to: week.to } : {}),
                })}
                value={`${hours(report.weekHours)} hrs`}
                context=" approved this week, view these contributions"
              />
            )
          ) : (
            <p className={styles.metricValue}>{reportValue(null)}</p>
          )}
          <p className={styles.metricNote}>
            {reportNote(
              week
                ? `Approved, ${week.from} to ${week.to} (${report?.timezone})`
                : "Approved this week",
            )}
          </p>
        </Tile>
        <Tile icon="clock" tone="teal" label="All time" busy={reportLoading}>
          {report ? (
            <MetricLink
              href={ledgerHref({ status: "approved" })}
              value={`${hours(report.approvedHours)} hrs`}
              context=" approved in total, view approved contributions"
            />
          ) : (
            <p className={styles.metricValue}>{reportValue(null)}</p>
          )}
          <p className={styles.metricNote}>
            {reportNote("From approved contributions")}
          </p>
          <Link href="/workspace/reports">View summary</Link>
        </Tile>
      </div>
      <Card label="Needs attention" busy={reportLoading}>
        <div className={styles.sectionHeading}>
          <div>
            <span className={styles.eyebrow}>Data quality</span>
            <h2>Needs attention</h2>
          </div>
          <Link href={ledgerHref({ status: "pending" })}>View pending</Link>
        </div>
        {report ? (
          <ul className={styles.attentionList}>
            <Attention
              href={ledgerHref({ status: "pending" })}
              label="Pending contributions"
              value={ledger?.pendingContributions}
              tone="info"
            />
            <Attention
              href={ledgerHref({ status: "pending", duration: "unknown" })}
              label="Unknown duration"
              value={ledger?.pendingUnknownDuration}
              tone="warn"
            />
            <Attention
              href={ledgerHref({ status: "pending", membership: "unresolved" })}
              label="Unresolved volunteer"
              value={ledger?.pendingUnresolvedVolunteer}
              tone="warn"
            />
            <Attention
              href="/workspace/needs"
              label="Unassigned open needs"
              value={report.unassignedOpenNeeds}
              tone="quiet"
            />
            {report.oldestQueuedReviewAt !== undefined && (
              <Attention
                href="/workspace/inbox"
                label="Oldest in review queue"
                value={
                  report.oldestQueuedReviewAt === null
                    ? "None"
                    : age(report.oldestQueuedReviewAt, now)
                }
                tone="info"
              />
            )}
          </ul>
        ) : reportLoading ? (
          <Skeleton height={56} />
        ) : (
          <p className={styles.metricNote}>Report unavailable</p>
        )}
      </Card>
      <div className={styles.overviewGrid}>
        <Card>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Up next</span>
              <h2>Priorities</h2>
            </div>
            <Link href="/workspace/inbox">View inbox</Link>
          </div>
          {(snapshot.queue.length > 0 || failed > 0 || urgent > 0) && (
            <ul className={styles.list}>
              {snapshot.queue.length > 0 && (
                <li className={`${styles.priority} ${styles.sevInfo}`}>
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Icon name="inbox" size={20} />
                  </span>
                  <div>
                    <strong>
                      {snapshot.queue.length} updates awaiting review
                    </strong>
                    <span>
                      Compare the proposed fields with the original evidence.
                    </span>
                  </div>
                </li>
              )}
              {failed > 0 && (
                <li className={`${styles.priority} ${styles.sevDanger}`}>
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Icon name="alert" size={20} />
                  </span>
                  <div>
                    <strong>
                      {failed} processing{" "}
                      {failed === 1 ? "failure" : "failures"}
                    </strong>
                    <span>
                      Inspect the original update and retry processing.
                    </span>
                  </div>
                </li>
              )}
              {urgent > 0 && (
                <li className={`${styles.priority} ${styles.sevWarn}`}>
                  <span className={styles.rowIcon} aria-hidden="true">
                    <Icon name="flag" size={20} />
                  </span>
                  <div>
                    <strong>
                      {urgent} urgent {urgent === 1 ? "need" : "needs"}
                    </strong>
                    <span>
                      Check ownership and next steps on the needs board.
                    </span>
                  </div>
                </li>
              )}
            </ul>
          )}
          {!snapshot.queue.length && !failed && !urgent && (
            <EmptyState icon="check" title="All caught up">
              No urgent work right now.
            </EmptyState>
          )}
        </Card>
        <Card>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Keep things moving</span>
              <h2>Open needs</h2>
            </div>
            <Link href="/workspace/needs">View board</Link>
          </div>
          {openNeeds.length ? (
            <ul className={styles.list}>
              {openNeeds.slice(0, 4).map((n) => (
                <li
                  className={`${styles.priority} ${
                    n.urgency === "urgent" ? styles.sevWarn : styles.sevQuiet
                  }`}
                  key={n.needId}
                >
                  <div>
                    <strong>{n.summary}</strong>
                    <span className={styles.badges}>
                      <Badge
                        tone={n.urgency === "urgent" ? "danger" : "neutral"}
                      >
                        {n.urgency === "urgent" ? "Urgent" : "Routine"}
                      </Badge>
                      <Badge tone="info">{n.status}</Badge>
                      {n.provisional && (
                        <Badge tone="accent">Provisional</Badge>
                      )}
                      <span>Due {date(n.dueAt)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="needs" title="Nothing open">
              No open needs.
            </EmptyState>
          )}
        </Card>
        {report?.topContributors !== undefined && (
          <Card>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Approved time</span>
                <h2>Top contributors</h2>
              </div>
              <Link href={ledgerHref({ status: "approved" })}>View ledger</Link>
            </div>
            {report.topContributors.length ? (
              <ol className={styles.list}>
                {report.topContributors.map((c) => (
                  <li key={c.membershipId}>
                    <Link
                      className={`${styles.priority} ${styles.sevQuiet} ${styles.rowLink}`}
                      href={ledgerHref({
                        status: "approved",
                        membership: c.membershipId,
                      })}
                    >
                      <span className={styles.rowIcon} aria-hidden="true">
                        <Icon name="user" size={20} />
                      </span>
                      <div>
                        <strong>{memberName(c.membershipId)}</strong>
                        <span>
                          {hours(c.approvedMinutes / 60)} hrs ·{" "}
                          {c.approvedContributions}{" "}
                          {c.approvedContributions === 1
                            ? "contribution"
                            : "contributions"}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState icon="clock" title="No approved time yet">
                Approved contributions will rank volunteers here.
              </EmptyState>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
