"use client";

import {
  type ContributionRecord,
  productEndpoints,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, type ReactNode, useState } from "react";
import { Card as BaseCard } from "../card";
import { Badge, Button, Icon, Select, TextInput } from "../foundation";
import styles from "./ledger.module.css";
import { key, type Mutate, PendingSource } from "./shared";

function Card({ children }: { children: ReactNode }) {
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}
export function Activities({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  const [formKey, setFormKey] = useState(0);
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
      <h2 className={styles.sectionTitle}>Contribution ledger</h2>
      {snapshot.contributions.length ? (
        <div className={styles.ledger}>
          {snapshot.contributions.map((c) => (
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
