"use client";

import {
  type NeedRecord,
  productEndpoints,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, type ReactNode, useState } from "react";
import { Card as BaseCard } from "../card";
import { Badge, Icon, Select } from "../foundation";
import styles from "./needs.module.css";
import { date, key, type Mutate } from "./shared";

function Card({ children }: { children: ReactNode }) {
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}
const instant = (value: FormDataEntryValue | null) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};
export function Needs({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  const [formError, setFormError] = useState("");
  const [urgency, setUrgency] = useState("routine");
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const dueAt = instant(f.get("due"));
    const acknowledgeBy = instant(f.get("acknowledgeBy"));
    if (dueAt === undefined || acknowledgeBy === undefined) {
      setFormError("Enter a valid date and time.");
      return;
    }
    setFormError("");
    if (
      await mutate(
        productEndpoints.need,
        {
          schemaVersion: 1,
          idempotencyKey: key(),
          category: String(f.get("category")),
          urgency,
          summary: String(f.get("summary")),
          provisional: f.get("provisional") === "on",
          dueAt,
          acknowledgeBy,
          origin: { kind: "staff", reason: String(f.get("reason")) },
        },
        "Need created.",
      )
    ) {
      form.reset();
      setUrgency("routine");
    }
  }
  return (
    <>
      <h1>Needs board</h1>
      <p>Track ownership, acknowledgment and resolution.</p>
      <details className={styles.utilityDisclosure}>
        <summary>Create a need</summary>
        <Card>
          <h2>Create a need</h2>
          <form onSubmit={create} className={styles.form}>
            <label>
              Category
              <input name="category" required maxLength={100} />
            </label>
            <label>
              Summary
              <textarea name="summary" required maxLength={2000} />
            </label>
            <div className={styles.field}>
              <label htmlFor="need-urgency">Urgency</label>
              <Select
                id="need-urgency"
                name="urgency"
                value={urgency}
                onChange={(e) => setUrgency(e.target.value)}
              >
                <option value="routine">Routine</option>
                <option value="urgent">Urgent</option>
              </Select>
            </div>
            <label>
              Due by
              <input name="due" type="datetime-local" />
            </label>
            <label>
              Acknowledge by
              <input name="acknowledgeBy" type="datetime-local" />
            </label>
            <label className={styles.check}>
              <input name="provisional" type="checkbox" /> Provisional
            </label>
            <label>
              Reason for staff entry
              <input name="reason" required maxLength={2000} />
            </label>
            <p role="alert" className={styles.formError}>
              {formError}
            </p>
            <div className={styles.actions}>
              <button type="submit">Create need</button>
            </div>
          </form>
        </Card>
      </details>
      <div className={styles.board}>
        {(["new", "assigned", "acknowledged"] as const).map((status) => (
          <section
            className={`${styles.boardColumn} ${styles[status]}`}
            key={status}
          >
            <h2 className={styles.columnHead}>
              {status === "new"
                ? "New"
                : status === "assigned"
                  ? "Assigned"
                  : "Acknowledged"}{" "}
              <span className={styles.count}>
                {snapshot.needs.filter((n) => n.status === status).length}
              </span>
            </h2>
            {snapshot.needs
              .filter((n) => n.status === status)
              .sort(
                (a, b) =>
                  Number(b.urgency === "urgent") -
                  Number(a.urgency === "urgent"),
              )
              .map((n) => (
                <Need
                  key={`${n.needId}-${n.revision}`}
                  need={n}
                  members={snapshot.members}
                  mutate={mutate}
                />
              ))}
            {!snapshot.needs.some((n) => n.status === status) && (
              <p className={styles.empty}>Nothing here yet.</p>
            )}
          </section>
        ))}
      </div>
      <details className={styles.utilityDisclosure}>
        <summary>
          Completed needs (
          {
            snapshot.needs.filter(
              (n) => n.status === "resolved" || n.status === "cancelled",
            ).length
          }
          )
        </summary>
        {snapshot.needs
          .filter((n) => n.status === "resolved" || n.status === "cancelled")
          .map((n) => (
            <Need
              key={`${n.needId}-${n.revision}`}
              need={n}
              members={snapshot.members}
              mutate={mutate}
            />
          ))}
      </details>
    </>
  );
}
function Need({
  need: n,
  members,
  mutate,
}: {
  need: NeedRecord;
  members: WorkspaceSnapshot["members"];
  mutate: Mutate;
}) {
  const [formError, setFormError] = useState("");
  const [owner, setOwner] = useState("");
  const [action, setAction] = useState(
    n.status === "resolved" || n.status === "cancelled" ? "reopen" : "assign",
  );
  async function transition(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const acknowledgeBy = instant(f.get("acknowledgeBy"));
    if (action === "assign" && acknowledgeBy === undefined) {
      setFormError("Enter a valid date and time.");
      return;
    }
    if (action === "assign" && !owner) {
      setFormError("Select a member.");
      return;
    }
    setFormError("");
    const base = {
      schemaVersion: 1,
      idempotencyKey: key(),
      needId: n.needId,
      expectedRevision: n.revision,
      action,
    };
    const body =
      action === "assign"
        ? {
            ...base,
            ownerMembershipId: owner,
            acknowledgeBy,
          }
        : action === "resolve"
          ? { ...base, resolution: String(f.get("reason")) }
          : action === "cancel" || action === "reopen"
            ? { ...base, reason: String(f.get("reason")) }
            : base;
    await mutate(productEndpoints.needTransition, body, "Need updated.");
  }
  const open =
    n.status === "new" ||
    n.status === "assigned" ||
    n.status === "acknowledged";
  return (
    <Card>
      <h2 className={styles.needTitle}>{n.summary}</h2>
      <div className={styles.badges}>
        <Badge tone={n.urgency === "urgent" ? "danger" : "neutral"}>
          {n.urgency}
        </Badge>
        {n.provisional && <Badge tone="warning">Provisional</Badge>}
        <Badge tone="neutral">{n.status}</Badge>
      </div>
      <p className={styles.category}>{n.category}</p>
      <div className={styles.meta}>
        <p className={styles.metaRow}>
          <Icon name="user" size={16} />
          <span>
            Owner:{" "}
            {members.find((m) => m.membershipId === n.ownerMembershipId)
              ?.name ??
              (n.ownerMembershipId ? "Assigned member" : "Unassigned")}
          </span>
        </p>
        <p className={styles.metaRow}>
          <Icon name="calendar" size={16} />
          <span>Due: {date(n.dueAt)}</span>
        </p>
        <p className={styles.metaRow}>
          <Icon name="clock" size={16} />
          <span>Acknowledge by: {date(n.acknowledgeBy)}</span>
        </p>
        <p className={styles.metaRow}>
          <Icon name="check" size={16} />
          <span>
            Acknowledged: {date(n.acknowledgedAt)}
            {n.resolution && ` · Resolution: ${n.resolution}`}
          </span>
        </p>
      </div>
      <details>
        <summary>Manage need</summary>
        <p className={styles.technical}>Revision {n.revision}</p>
        <form onSubmit={transition} className={styles.form}>
          <div className={styles.field}>
            <label htmlFor={`need-action-${n.needId}`}>Action</label>
            <Select
              id={`need-action-${n.needId}`}
              value={action}
              onChange={(e) => setAction(e.target.value)}
            >
              {open && <option value="assign">Assign</option>}
              {n.status === "assigned" && (
                <option value="acknowledge">Acknowledge</option>
              )}
              {open && <option value="resolve">Resolve</option>}
              {open && <option value="cancel">Cancel</option>}
              {!open && <option value="reopen">Reopen</option>}
            </Select>
          </div>
          {action === "assign" && (
            <>
              <div className={styles.field}>
                <label htmlFor={`need-owner-${n.needId}`}>Owner</label>
                <Select
                  id={`need-owner-${n.needId}`}
                  name="owner"
                  required
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="" disabled>
                    Select a member
                  </option>
                  {members.map((m) => (
                    <option key={m.membershipId} value={m.membershipId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </div>
              <label>
                Acknowledge by
                <input name="acknowledgeBy" type="datetime-local" />
              </label>
            </>
          )}
          {["resolve", "cancel", "reopen"].includes(action) && (
            <label>
              {action === "resolve" ? "Resolution" : "Reason"}
              <textarea name="reason" required maxLength={2000} />
            </label>
          )}
          <p role="alert" className={styles.formError}>
            {formError}
          </p>
          <div className={styles.actions}>
            <button type="submit">Update need</button>
          </div>
        </form>
      </details>
    </Card>
  );
}
