"use client";

import {
  type NeedRecord,
  productEndpoints,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, useState } from "react";
import { Card } from "../card";
import { Badge, Field, Icon, Select } from "../foundation";
import styles from "./needs.module.css";
import { date, key, type Mutate } from "./shared";

const requiredText = (message: string) => (value: string) =>
  value.trim() ? "" : message;
const describedBy = (id: string, error?: string) =>
  error ? `${id}-error` : undefined;
function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (id: string, message: string) =>
    setErrors((current) => ({ ...current, [id]: message }));
  return { errors, set, setAll: setErrors };
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
  const field = useFieldErrors();
  const createChecks: Record<string, (value: string) => string> = {
    "need-category": requiredText("Enter a category."),
    "need-summary": requiredText("Enter a summary."),
    "need-reason": requiredText("Enter the reason for this staff entry."),
  };
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const values: Record<string, string> = {
      "need-category": String(f.get("category") ?? ""),
      "need-summary": String(f.get("summary") ?? ""),
      "need-reason": String(f.get("reason") ?? ""),
    };
    const found = Object.fromEntries(
      Object.entries(createChecks).map(([id, check]) => [
        id,
        check(values[id] ?? ""),
      ]),
    );
    field.setAll(found);
    const firstInvalid = Object.keys(found).find((id) => found[id]);
    if (firstInvalid) {
      document.getElementById(firstInvalid)?.focus();
      return;
    }
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
      field.setAll({});
      setUrgency("routine");
    }
  }
  return (
    <>
      <h1>Needs board</h1>
      <p>Track ownership, acknowledgment and resolution.</p>
      <details className={styles.utilityDisclosure}>
        <summary>Create a need</summary>
        <Card className={styles.card}>
          <h2>Create a need</h2>
          <form onSubmit={create} className={styles.form} noValidate>
            <div className={styles.fieldWrap}>
              <Field
                id="need-category"
                label="Category"
                required
                error={field.errors["need-category"] ?? ""}
              >
                <input
                  id="need-category"
                  name="category"
                  required
                  maxLength={100}
                  aria-invalid={
                    field.errors["need-category"] ? true : undefined
                  }
                  aria-describedby={describedBy(
                    "need-category",
                    field.errors["need-category"],
                  )}
                  onBlur={(e) =>
                    field.set(
                      "need-category",
                      createChecks["need-category"]?.(e.target.value) ?? "",
                    )
                  }
                />
              </Field>
            </div>
            <div className={styles.fieldWrap}>
              <Field
                id="need-summary"
                label="Summary"
                required
                error={field.errors["need-summary"] ?? ""}
              >
                <textarea
                  id="need-summary"
                  name="summary"
                  required
                  maxLength={2000}
                  aria-invalid={field.errors["need-summary"] ? true : undefined}
                  aria-describedby={describedBy(
                    "need-summary",
                    field.errors["need-summary"],
                  )}
                  onBlur={(e) =>
                    field.set(
                      "need-summary",
                      createChecks["need-summary"]?.(e.target.value) ?? "",
                    )
                  }
                />
              </Field>
            </div>
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
            <div className={styles.fieldWrap}>
              <Field
                id="need-reason"
                label="Reason for staff entry"
                required
                error={field.errors["need-reason"] ?? ""}
              >
                <input
                  id="need-reason"
                  name="reason"
                  required
                  maxLength={2000}
                  aria-invalid={field.errors["need-reason"] ? true : undefined}
                  aria-describedby={describedBy(
                    "need-reason",
                    field.errors["need-reason"],
                  )}
                  onBlur={(e) =>
                    field.set(
                      "need-reason",
                      createChecks["need-reason"]?.(e.target.value) ?? "",
                    )
                  }
                />
              </Field>
            </div>
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
  const field = useFieldErrors();
  const ownerId = `need-owner-${n.needId}`;
  const reasonId = `need-reason-${n.needId}`;
  const [action, setAction] = useState(
    n.status === "resolved" || n.status === "cancelled" ? "reopen" : "assign",
  );
  async function transition(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const acknowledgeBy = instant(f.get("acknowledgeBy"));
    const found: Record<string, string> = {};
    if (action === "assign" && !owner) found[ownerId] = "Choose an owner.";
    if (
      ["resolve", "cancel", "reopen"].includes(action) &&
      !String(f.get("reason") ?? "").trim()
    )
      found[reasonId] =
        action === "resolve"
          ? "Enter how this need was resolved."
          : "Enter a reason.";
    field.setAll(found);
    const firstInvalid = [ownerId, reasonId].find((id) => found[id]);
    if (firstInvalid) {
      document.getElementById(firstInvalid)?.focus();
      return;
    }
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
    <Card className={styles.card}>
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
        <form onSubmit={transition} className={styles.form} noValidate>
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
              <div className={styles.fieldWrap}>
                <Field
                  id={ownerId}
                  label="Owner"
                  required
                  error={field.errors[ownerId] ?? ""}
                >
                  <Select
                    id={ownerId}
                    name="owner"
                    required
                    aria-required="true"
                    aria-invalid={field.errors[ownerId] ? true : undefined}
                    aria-describedby={describedBy(
                      ownerId,
                      field.errors[ownerId],
                    )}
                    value={owner}
                    onChange={(e) => {
                      setOwner(e.target.value);
                      if (e.target.value) field.set(ownerId, "");
                    }}
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
                </Field>
              </div>
              <label>
                Acknowledge by
                <input name="acknowledgeBy" type="datetime-local" />
              </label>
            </>
          )}
          {["resolve", "cancel", "reopen"].includes(action) && (
            <div className={styles.fieldWrap}>
              <Field
                id={reasonId}
                label={action === "resolve" ? "Resolution" : "Reason"}
                required
                error={field.errors[reasonId] ?? ""}
              >
                <textarea
                  id={reasonId}
                  name="reason"
                  required
                  maxLength={2000}
                  aria-invalid={field.errors[reasonId] ? true : undefined}
                  aria-describedby={describedBy(
                    reasonId,
                    field.errors[reasonId],
                  )}
                  onBlur={(e) =>
                    field.set(
                      reasonId,
                      e.target.value.trim()
                        ? ""
                        : action === "resolve"
                          ? "Enter how this need was resolved."
                          : "Enter a reason.",
                    )
                  }
                />
              </Field>
            </div>
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
