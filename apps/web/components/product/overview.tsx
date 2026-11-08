"use client";

import type { ProductReport, WorkspaceSnapshot } from "@relay/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { request } from "../api-client";
import {
  Badge,
  EmptyState,
  Icon,
  type IconName,
  Skeleton,
} from "../foundation";
import styles from "./overview.module.css";
import { date } from "./shared";

function Card({
  children,
  className = "",
  busy,
}: {
  children: ReactNode;
  className?: string;
  busy?: boolean;
}) {
  return (
    <section
      className={`${styles.card} ${className}`}
      {...(busy ? { "aria-busy": true } : {})}
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
  tone: "teal" | "clay" | "amber";
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
export function Overview({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [report, setReport] = useState<ProductReport | null>(null);
  const [reportError, setReportError] = useState(false);
  useEffect(() => {
    let live = true;
    void request<ProductReport>("/api/product/reports").then((result) => {
      if (!live) return;
      if (result.ok) setReport(result.value);
      else setReportError(true);
    });
    return () => {
      live = false;
    };
  }, []);
  const openNeeds = snapshot.needs
    .filter((n) => ["new", "assigned", "acknowledged"].includes(n.status))
    .sort(
      (a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"),
    );
  const failed = snapshot.sources.filter((s) => s.status === "failed").length;
  const urgent = openNeeds.filter((n) => n.urgency === "urgent").length;
  const reportLoading = !report && !reportError;
  return (
    <>
      <div className={styles.pageHeader}>
        <div className={styles.headerText}>
          <span className={styles.eyebrow}>Your workspace</span>
          <h1>Overview</h1>
          <p>Here's what needs your attention today.</p>
        </div>
        <a className={styles.primaryLink} href="/workspace/inbox">
          Review updates <Icon name="arrowRight" size={16} />
        </a>
      </div>
      <div className={styles.metrics}>
        <Tile icon="inbox" tone="amber" label="Awaiting review">
          <p className={styles.metricValue}>{snapshot.queue.length}</p>
          <p className={styles.metricNote}>Updates ready for a decision</p>
          <a href="/workspace/inbox">Open inbox</a>
        </Tile>
        <Tile icon="needs" tone="clay" label="Open needs">
          <p className={styles.metricValue}>{openNeeds.length}</p>
          <p className={styles.metricNote}>Needs being tracked</p>
          <a href="/workspace/needs">View needs</a>
        </Tile>
        <Tile
          icon="clock"
          tone="teal"
          label="Approved time"
          busy={reportLoading}
        >
          <p className={styles.metricValue}>
            {report ? (
              `${report.approvedHours} hrs`
            ) : reportLoading ? (
              <Skeleton width={96} height={40} />
            ) : (
              "—"
            )}
          </p>
          <p className={styles.metricNote}>
            {reportError
              ? "Report unavailable"
              : report
                ? "From approved contributions"
                : "Loading report…"}
          </p>
          <a href="/workspace/reports">View summary</a>
        </Tile>
      </div>
      <div className={styles.overviewGrid}>
        <Card>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Up next</span>
              <h2>Priorities</h2>
            </div>
            <a href="/workspace/inbox">View inbox</a>
          </div>
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
                    {failed} processing {failed === 1 ? "failure" : "failures"}
                  </strong>
                  <span>Inspect the original update and retry processing.</span>
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
            <a href="/workspace/needs">View board</a>
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
      </div>
    </>
  );
}
