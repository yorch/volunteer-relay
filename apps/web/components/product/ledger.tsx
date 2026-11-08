"use client";

import {
  type ContributionRecord,
  contributionStatusSchema,
  productEndpoints,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Card as BaseCard } from "../card";
import { Badge, Button, Icon, Select, TextInput } from "../foundation";
import styles from "./ledger.module.css";
import { key, type Mutate, PendingSource } from "./shared";

function Card({ children }: { children: ReactNode }) {
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}

/**
 * Deep-link filter for the contribution ledger. `membership` is a membership
 * id or "unresolved" (no volunteer yet); `duration` "unknown" keeps only
 * contributions without a known duration. Dates are inclusive activity dates.
 */
export interface LedgerFilter {
  status?: ContributionRecord["status"];
  membership?: string;
  contribution?: string;
  duration?: "unknown";
  from?: string;
  to?: string;
}
const ledgerParams = [
  "status",
  "membership",
  "contribution",
  "duration",
  "from",
  "to",
] as const;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
export function ledgerHref(filter: LedgerFilter) {
  const params = new URLSearchParams();
  for (const name of ledgerParams) {
    const value = filter[name];
    if (value) params.set(name, value);
  }
  const query = params.toString();
  return `/workspace/activities${query ? `?${query}` : ""}` as Route;
}
/** Reads a filter from a query string, ignoring malformed values. */
export function parseLedgerFilter(search: string): LedgerFilter {
  const params = new URLSearchParams(search);
  const filter: LedgerFilter = {};
  const status = contributionStatusSchema.safeParse(params.get("status"));
  if (status.success) filter.status = status.data;
  const membership = params.get("membership")?.trim();
  if (membership && membership.length <= 200) filter.membership = membership;
  const contribution = params.get("contribution")?.trim();
  if (contribution && contribution.length <= 200)
    filter.contribution = contribution;
  if (params.get("duration") === "unknown") filter.duration = "unknown";
  const from = params.get("from"),
    to = params.get("to");
  if (from && isoDate.test(from)) filter.from = from;
  if (to && isoDate.test(to)) filter.to = to;
  return filter;
}
function matches(
  c: ContributionRecord,
  localDate: string | null | undefined,
  f: LedgerFilter,
) {
  if (f.contribution && c.contributionId !== f.contribution) return false;
  if (f.status && c.status !== f.status) return false;
  if (f.membership === "unresolved") {
    if (c.membershipId !== null) return false;
  } else if (f.membership && c.membershipId !== f.membership) return false;
  if (f.duration === "unknown" && c.durationMinutes !== null) return false;
  // A dated filter excludes contributions whose activity date is unknown.
  if ((f.from || f.to) && !localDate) return false;
  if (f.from && localDate && localDate < f.from) return false;
  if (f.to && localDate && localDate > f.to) return false;
  return true;
}
const statusLabel: Record<ContributionRecord["status"], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};
function describeFilter(
  f: LedgerFilter,
  members: WorkspaceSnapshot["members"],
) {
  const parts: string[] = [];
  if (f.status) parts.push(statusLabel[f.status]);
  if (f.duration === "unknown") parts.push("unknown duration");
  if (f.membership === "unresolved") parts.push("unresolved volunteer");
  else if (f.membership)
    parts.push(
      members.find((m) => m.membershipId === f.membership)?.name ??
        "one volunteer",
    );
  if (f.from && f.to) parts.push(`${f.from} to ${f.to}`);
  else if (f.from) parts.push(`from ${f.from}`);
  else if (f.to) parts.push(`through ${f.to}`);
  if (f.contribution) parts.push("one contribution");
  return parts.join(" · ");
}
function currentSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}
export function Activities({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  const [formKey, setFormKey] = useState(0);
  const router = useRouter();
  // The workspace renders client-side only, so the URL is readable on first
  // render; back/forward navigation re-reads it.
  const [filter, setFilter] = useState<LedgerFilter>(() =>
    parseLedgerFilter(currentSearch()),
  );
  useEffect(() => {
    const sync = () => setFilter(parseLedgerFilter(currentSearch()));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const filtered = Object.keys(filter).length > 0;
  const activityDate = (c: ContributionRecord) =>
    snapshot.activities?.find((a) => a.activityId === c.activityId)?.localDate;
  const shown = filtered
    ? snapshot.contributions.filter((c) => matches(c, activityDate(c), filter))
    : snapshot.contributions;
  function clearFilter() {
    setFilter({});
    router.replace("/workspace/activities", { scroll: false });
    document.getElementById("contribution-ledger")?.focus();
  }
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const localDate = String(f.get("date") || "");
    const minutes = String(f.get("minutes") || "");
    if (
      await mutate(
        productEndpoints.activity,
        {
          schemaVersion: 1,
          idempotencyKey: key(),
          kind: String(f.get("kind")),
          localDate: localDate || null,
          datePrecision: localDate ? "day" : "unknown",
          beneficiaryReference: String(f.get("beneficiary") || "") || null,
          origin: { kind: "staff", reason: String(f.get("reason")) },
          contributions: [
            {
              membershipId: String(f.get("member") || "") || null,
              durationMinutes: minutes ? Number(minutes) : null,
            },
          ],
        },
        "Activity recorded.",
      )
    ) {
      form.reset();
      setFormKey((n) => n + 1);
    }
  }
  return (
    <>
      <header className={styles.heading}>
        <h1>Activities and contributions</h1>
        <p>
          Approved contributions form the reporting ledger. Unknown durations
          remain pending.
        </p>
      </header>
      <h2
        id="contribution-ledger"
        tabIndex={-1}
        className={styles.sectionTitle}
      >
        Contribution ledger
      </h2>
      {filtered && (
        <section className={styles.filterBar} aria-label="Ledger filter">
          <p>
            <Icon name="filter" size={16} />
            <span>
              <strong>Filtered:</strong>{" "}
              {describeFilter(filter, snapshot.members)}
            </span>
            <span className={styles.filterCount} aria-live="polite">
              {shown.length} of {snapshot.contributions.length}{" "}
              {snapshot.contributions.length === 1
                ? "contribution"
                : "contributions"}
            </span>
          </p>
          <Button variant="secondary" onClick={clearFilter}>
            Clear filter
          </Button>
        </section>
      )}
      {filtered && snapshot.contributions.length > 0 && !shown.length ? (
        <p>No contributions match this filter.</p>
      ) : shown.length ? (
        <div className={styles.ledger}>
          {shown.map((c) => (
            <Contribution
              key={c.contributionId}
              contribution={c}
              activity={snapshot.activities?.find(
                (a) => a.activityId === c.activityId,
              )}
              members={snapshot.members}
              mutate={mutate}
            />
          ))}
        </div>
      ) : (
        <p>No contributions yet.</p>
      )}
      <details className={styles.utilityDisclosure}>
        <summary>Record an activity</summary>
        <Card>
          <h2>Record an activity</h2>
          <form key={formKey} onSubmit={create}>
            <div className={styles.field}>
              <label htmlFor="activity-kind">Activity type</label>
              <TextInput
                id="activity-kind"
                name="kind"
                required
                maxLength={100}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="activity-date">
                Date (leave blank if unknown)
              </label>
              <TextInput id="activity-date" name="date" type="date" />
            </div>
            <div className={styles.field}>
              <label htmlFor="activity-beneficiary">
                Beneficiary reference (optional)
              </label>
              <TextInput
                id="activity-beneficiary"
                name="beneficiary"
                maxLength={200}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="activity-member">Volunteer</label>
              <Select id="activity-member" name="member">
                <option value="">Unknown</option>
                {snapshot.members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className={styles.field}>
              <label htmlFor="activity-minutes">
                Duration in minutes (leave blank if unknown)
              </label>
              <TextInput
                id="activity-minutes"
                name="minutes"
                type="number"
                min="1"
                max="1440"
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="activity-reason">Reason for staff entry</label>
              <TextInput
                id="activity-reason"
                name="reason"
                required
                maxLength={2000}
              />
            </div>
            <div className={styles.actions}>
              <Button type="submit">Record activity</Button>
            </div>
          </form>
        </Card>
      </details>
    </>
  );
}
function Contribution({
  contribution: c,
  activity,
  members,
  mutate,
}: {
  contribution: ContributionRecord;
  activity: NonNullable<WorkspaceSnapshot["activities"]>[number] | undefined;
  members: WorkspaceSnapshot["members"];
  mutate: Mutate;
}) {
  const [showSource, setShowSource] = useState(false);
  async function transition(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const action = String(f.get("action"));
    const base = {
      schemaVersion: 1,
      idempotencyKey: key(),
      contributionId: c.contributionId,
      expectedRevision: c.revision,
      action,
    };
    const body =
      action === "correct"
        ? {
            ...base,
            durationMinutes: Number(f.get("minutes")),
            reason: String(f.get("reason")),
          }
        : base;
    await mutate(productEndpoints.contribution, body, "Contribution updated.");
  }
  const tone =
    c.status === "approved"
      ? "success"
      : c.status === "pending"
        ? "warning"
        : "neutral";
  const volunteer =
    members.find((m) => m.membershipId === c.membershipId)?.name ??
    (c.membershipId ? "Volunteer" : "Unknown volunteer");
  return (
    <div className={styles.ledgerRow}>
      <div className={styles.ledgerMain}>
        <div className={styles.activity}>
          <strong>
            {activity?.kind || `Activity ${c.activityId.slice(0, 8)}`}
          </strong>
          <span className={styles.date}>
            <Icon name="calendar" size={16} />
            <span>{activity?.localDate || "Date unknown"}</span>
          </span>
        </div>
        <p className={styles.meta}>
          <span>{volunteer}</span>
          {c.durationMinutes === null ? (
            <span className={styles.unknownChip}>Unknown duration</span>
          ) : (
            <span className={styles.minutes}>{c.durationMinutes} minutes</span>
          )}
          <Badge tone={tone}>{c.status}</Badge>
        </p>
      </div>
      {c.origin.kind === "source" && (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => setShowSource(true)}>
            Inspect current source evidence
          </Button>
        </div>
      )}
      {showSource && c.origin.kind === "source" && (
        <PendingSource
          sourceId={c.origin.sourceId}
          status="current evidence"
          close={() => setShowSource(false)}
        />
      )}
      <details className={styles.details}>
        <summary>Details and correction</summary>
        <p>
          Activity {c.activityId} · contribution revision {c.revision}
        </p>
        <p>
          {c.origin.kind === "source"
            ? `Source ${c.origin.sourceId} · revision ${c.origin.sourceRevision}`
            : `Staff entry reason: ${c.origin.reason}`}
        </p>
        {(c.status === "pending" || c.status === "approved") && (
          <form onSubmit={transition}>
            <div className={styles.field}>
              <label htmlFor={`action-${c.contributionId}`}>Action</label>
              <Select id={`action-${c.contributionId}`} name="action">
                <option value="correct">Correct duration</option>
                {c.status === "pending" && (
                  <option value="approve">Approve</option>
                )}
              </Select>
            </div>
            <div className={styles.field}>
              <label htmlFor={`minutes-${c.contributionId}`}>
                Corrected minutes
              </label>
              <TextInput
                id={`minutes-${c.contributionId}`}
                name="minutes"
                type="number"
                min="1"
                max="1440"
              />
            </div>
            <div className={styles.field}>
              <label htmlFor={`reason-${c.contributionId}`}>
                Reason for correction
              </label>
              <TextInput
                id={`reason-${c.contributionId}`}
                name="reason"
                maxLength={2000}
                aria-describedby={`reason-hint-${c.contributionId}`}
              />
              <span
                id={`reason-hint-${c.contributionId}`}
                className={styles.hint}
              >
                Explain the correction using the source evidence or your staff
                knowledge.
              </span>
            </div>
            <div className={styles.actions}>
              <Button type="submit">Update contribution</Button>
            </div>
          </form>
        )}
      </details>
    </div>
  );
}
