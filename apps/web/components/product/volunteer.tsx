"use client";

import {
  type ContributionRecord,
  productEndpoints,
  type Receipt,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, useRef, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card, Live } from "../card";
import { Badge, Button, Field, Icon, TextArea } from "../foundation";
import { date, key, type Mutate, PendingSource } from "./shared";
import styles from "./volunteer.module.css";

export function Volunteer({
  snapshot,
  mutate,
  refresh,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
  refresh: () => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [receipt, setReceipt] = useState("");
  const [pending, setPending] = useState(false);
  const [submissionKey, setSubmissionKey] = useState(key);
  const [photo, setPhoto] = useState<File | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
  const [photoError, setPhotoError] = useState("");
  const photoKey = useRef<string | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    if (photo) {
      if (
        photo.size > 10 * 1024 * 1024 ||
        !["image/png", "image/jpeg", "image/webp"].includes(photo.type)
      ) {
        setPhotoError("Choose a PNG, JPEG or WebP photo no larger than 10 MB.");
        setPending(false);
        return;
      }
      photoKey.current ??= key();
      const form = new FormData();
      form.set("text", text);
      form.set("file", photo);
      form.set("idempotencyKey", photoKey.current);
      const result = await request<Receipt>("/api/product/source-photo", form);
      if (!result.ok) setPhotoError(errorMessage(result.error.code));
      else {
        setReceipt(
          `Receipt: ${result.value.sourceId} · revision ${result.value.revision} · received`,
        );
        setText("");
        setPhoto(null);
        if (photoInput.current) photoInput.current.value = "";
        photoKey.current = null;
        setPhotoError("");
        await refresh();
      }
      setPending(false);
      return;
    }
    const ok = await mutate(
      productEndpoints.sources,
      { schemaVersion: 1, idempotencyKey: submissionKey, text },
      "Your update was received.",
      (value) => {
        const receipt = value as { sourceId: string; revision: number };
        setReceipt(
          `Receipt: ${receipt.sourceId} · revision ${receipt.revision} · received`,
        );
      },
    );
    if (ok) {
      setText("");
      setSubmissionKey(key());
    }
    setPending(false);
  }
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>Your volunteer workspace</span>
        <h1>How did you help today?</h1>
        <p>Share an update with your team.</p>
      </header>
      <Card className={`${styles.card} ${styles.composeCard}`}>
        <form className={styles.volunteerForm} onSubmit={submit}>
          <Field id="update" label="Your update">
            <TextArea
              id="update"
              required
              maxLength={20000}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                photoKey.current = null;
              }}
              rows={6}
              placeholder="Tell your team what you did, when it happened, and how long you spent."
            />
          </Field>
          <div className={styles.fieldGroup}>
            <label htmlFor="photo">
              Photo (optional; PNG, JPEG or WebP, up to 10 MB)
            </label>
            <div className={styles.dropzone}>
              <span className={styles.dropzoneIcon} aria-hidden="true">
                <Icon name="camera" size={20} />
              </span>
              <span className={styles.dropzoneText}>
                <strong>{photo ? photo.name : "Add a photo"}</strong>
                {!photo && (
                  <span aria-hidden="true">Drop it here or browse</span>
                )}
              </span>
              <input
                id="photo"
                ref={photoInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  setPhoto(e.target.files?.[0] ?? null);
                  photoKey.current = null;
                  setPhotoError("");
                }}
              />
            </div>
          </div>
          <Live kind="alert" className={styles.error}>
            {photoError}
          </Live>
          <div className={styles.actions}>
            <Button className={styles.send} disabled={pending} type="submit">
              {pending ? "Sending…" : "Send update"}
            </Button>
          </div>
        </form>
        <Live kind="polite" className={styles.notice}>
          {receipt ? (
            <>
              <Icon name="check" size={20} />
              <span>{receipt}</span>
            </>
          ) : (
            ""
          )}
        </Live>
      </Card>
      <Card className={styles.card}>
        <h2>Your updates</h2>
        {snapshot.sources.length ? (
          <ul className={styles.updateList}>
            {snapshot.sources.map((source) => (
              <li key={source.sourceId}>
                <div className={styles.updateHeading}>
                  <strong>
                    {source.preview?.trim() || "Update without a text preview"}
                  </strong>
                  <Badge tone={statusTone(source.status)}>
                    {source.status}
                  </Badge>
                </div>
                <p>
                  <Icon name="calendar" size={16} />
                  <span>
                    {source.receivedAt
                      ? `Received ${date(source.receivedAt)}`
                      : "Received date unavailable"}
                  </span>
                </p>
                <div className={styles.updateActions}>
                  <Button
                    variant="secondary"
                    onClick={(event) => {
                      sourceTrigger.current = event.currentTarget;
                      setSourceId(source.sourceId);
                    }}
                  >
                    View my update
                  </Button>
                </div>
                <details>
                  <summary>Receipt details</summary>
                  <p>
                    Update {source.sourceId} · revision {source.revision}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>No updates yet.</p>
        )}
      </Card>
      {sourceId && (
        <PendingSource
          key={sourceId}
          sourceId={sourceId}
          status="your update"
          close={() => {
            setSourceId(null);
            requestAnimationFrame(() => sourceTrigger.current?.focus());
          }}
        />
      )}
      <Card className={styles.card}>
        <h2>Your contributions</h2>
        <ContributionList
          contributions={snapshot.contributions}
          members={snapshot.members}
        />
      </Card>
    </div>
  );
}
function statusTone(status: string) {
  if (/accept|approv|complete|processed|done/i.test(status)) return "success";
  if (/fail|reject|error/i.test(status)) return "danger";
  if (/queue|pending|review|receiv|process/i.test(status)) return "info";
  return "neutral";
}
function ContributionList({
  contributions,
  members,
}: {
  contributions: ContributionRecord[];
  members: WorkspaceSnapshot["members"];
}) {
  return contributions.length ? (
    <ul className={styles.list}>
      {contributions.map((c) => (
        <li key={c.contributionId}>
          <strong>
            {members.find((m) => m.membershipId === c.membershipId)?.name ??
              (c.membershipId ? "Volunteer" : "Unknown volunteer")}
          </strong>{" "}
          ·{" "}
          {c.durationMinutes === null
            ? "Unknown duration"
            : `${c.durationMinutes} minutes`}{" "}
          · {c.status}
        </li>
      ))}
    </ul>
  ) : (
    <p className={styles.empty}>No contributions yet.</p>
  );
}
