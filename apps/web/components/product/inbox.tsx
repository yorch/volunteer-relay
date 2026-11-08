"use client";

import {
  productEndpoints,
  type ReviewQueueEntry,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card as BaseCard, Live } from "../card";
import { Badge, EmptyState, Icon, Select } from "../foundation";
import styles from "./inbox.module.css";
import { date, key, type Mutate, PendingSource } from "./shared";

function Card({ children }: { children: ReactNode }) {
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}
const fieldLabel = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
export function Inbox({
  snapshot,
  mutate,
  refresh,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
  refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "review" | "queued" | "failed"
  >("review");
  const searchInput = useRef<HTMLInputElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected && window.matchMedia("(max-width: 760px)").matches)
      backButton.current?.focus();
  }, [selected]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [inspected, setInspected] = useState<string | null>(null);
  const queued = snapshot.sources.filter(
    (source) => source.status === "queued",
  );
  const inspectable = snapshot.sources.find(
    (source) =>
      source.sourceId === inspected &&
      (source.status === "failed" || source.status === "queued"),
  );
  const failed = snapshot.sources.filter(
    (source) => source.status === "failed",
  );
  const entry = snapshot.queue.find((e) => e.proposal.runId === selected);
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>Source inbox</h1>
        <p>Review the original update alongside its proposed fields.</p>
      </header>
      <nav className={styles.filterTabs} aria-label="Update status">
        {(["review", "queued", "failed"] as const).map((status) => (
          <button
            key={status}
            type="button"
            data-tone={status}
            aria-pressed={statusFilter === status}
            onClick={() => {
              setStatusFilter(status);
              setSelected(null);
              setInspected(null);
            }}
          >
            {status === "review"
              ? "Awaiting review"
              : status === "queued"
                ? "Queued"
                : "Failed"}{" "}
            <span className={styles.count}>
              {status === "review"
                ? snapshot.queue.length
                : status === "queued"
                  ? queued.length
                  : failed.length}
            </span>
          </button>
        ))}
      </nav>
      <details className={styles.utilityDisclosure}>
        <summary>Processing and reprocessing</summary>
        <Card>
          <h2>Processing failures</h2>
          {failed.length ? (
            <>
              <p>
                Retry processing these updates. The original evidence is
                retained.
              </p>
              <ul className={styles.list}>
                {failed.map((source) => (
                  <li key={source.sourceId} className={styles.processRow}>
                    <span className={styles.rowText}>
                      Source {source.sourceId} · revision {source.revision} ·
                      failed
                    </span>
                    <span className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        onClick={() => setInspected(source.sourceId)}
                      >
                        Inspect evidence
                      </button>
                      <button
                        type="button"
                        className={styles.btn}
                        disabled={retrying !== null}
                        onClick={async () => {
                          setRetrying(source.sourceId);
                          try {
                            await mutate(
                              "/api/product/retry-source",
                              { sourceId: source.sourceId },
                              "Processing retry requested.",
                            );
                          } finally {
                            setRetrying(null);
                          }
                        }}
                      >
                        {retrying === source.sourceId
                          ? "Requesting…"
                          : "Retry processing"}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>No processing failures.</p>
          )}
        </Card>
        <Card>
          <h2>Queued updates</h2>
          {queued.length ? (
            <ul className={styles.list}>
              {queued.map((source) => (
                <li key={source.sourceId} className={styles.processRow}>
                  <span className={styles.rowText}>
                    Source {source.sourceId} · revision {source.revision} ·
                    queued
                  </span>
                  <span className={styles.rowActions}>
                    <button
                      type="button"
                      className={styles.btnSecondary}
                      onClick={() => setInspected(source.sourceId)}
                    >
                      Inspect evidence
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No updates awaiting processing.</p>
          )}
        </Card>
        <Card>
          <h2>Reprocess an update</h2>
          <p>
            Run the current model and policy again. The original history stays
            available; pending decisions based on an earlier run become stale.
          </p>
          {snapshot.sources.filter((source) =>
            ["review", "accepted", "rejected"].includes(source.status),
          ).length ? (
            <ul className={styles.list}>
              {snapshot.sources
                .filter((source) =>
                  ["review", "accepted", "rejected"].includes(source.status),
                )
                .map((source) => (
                  <li key={source.sourceId} className={styles.processRow}>
                    <span className={styles.rowText}>
                      Source {source.sourceId} · revision {source.revision} ·{" "}
                      {source.status}
                    </span>
                    <span className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.btnSecondary}
                        disabled={retrying !== null}
                        onClick={async () => {
                          setRetrying(source.sourceId);
                          try {
                            await mutate(
                              "/api/product/reprocess-source",
                              {
                                sourceId: source.sourceId,
                                expectedRevision: source.revision,
                              },
                              "Reprocessing requested.",
                            );
                          } finally {
                            setRetrying(null);
                          }
                        }}
                      >
                        {retrying === source.sourceId
                          ? "Requesting…"
                          : "Reprocess with current model and policy"}
                      </button>
                    </span>
                  </li>
                ))}
            </ul>
          ) : (
            <p>No updates available to reprocess.</p>
          )}
        </Card>
      </details>
      {inspectable && (
        <PendingSource
          key={`${inspectable.sourceId}-${inspectable.revision}`}
          sourceId={inspectable.sourceId}
          status={inspectable.status}
          close={() => setInspected(null)}
        />
      )}
      {statusFilter !== "review" && (
        <Card>
          <h2>
            {statusFilter === "queued"
              ? "Queued updates"
              : "Processing failures"}
          </h2>
          <p>
            {statusFilter === "queued"
              ? "These updates are waiting to be processed."
              : "Inspect the evidence and retry processing from the processing menu."}
          </p>
          {(statusFilter === "queued" ? queued : failed).length ? (
            <ul className={`${styles.list}`}>
              {(statusFilter === "queued" ? queued : failed).map((source) => (
                <li key={source.sourceId}>
                  <button
                    type="button"
                    className={styles.row}
                    data-tone={statusFilter}
                    aria-pressed={inspected === source.sourceId}
                    onClick={() => setInspected(source.sourceId)}
                  >
                    <small>
                      Source {source.sourceId} · revision {source.revision}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>Nothing here yet.</p>
          )}
        </Card>
      )}
      {statusFilter === "review" &&
        (snapshot.queue.length === 0 ? (
          <Card>
            <EmptyState title="Inbox is clear" icon="check">
              No sources awaiting review.
            </EmptyState>
          </Card>
        ) : (
          <div
            className={`${styles.columns} ${entry ? styles.hasSelection : ""}`}
          >
            <div className={styles.inboxList}>
              <Card>
                <h2 className={styles.paneTitle}>
                  Awaiting review{" "}
                  <span className={styles.count}>{snapshot.queue.length}</span>
                </h2>
                <label className={styles.field}>
                  Search updates
                  <span className={styles.searchWrap}>
                    <Icon name="search" size={16} />
                    <input
                      type="search"
                      ref={searchInput}
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setSelected(null);
                      }}
                      placeholder="Search source or text"
                    />
                  </span>
                </label>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => void refresh()}
                >
                  <Icon name="refresh" size={16} />
                  Refresh inbox
                </button>
                <ul className={`${styles.list}`}>
                  {snapshot.queue
                    .filter((item) =>
                      `${item.source.sourceId} ${item.source.text ?? ""}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((item) => (
                      <li key={item.proposal.runId}>
                        <button
                          type="button"
                          className={styles.row}
                          data-tone="review"
                          aria-pressed={
                            entry?.proposal.runId === item.proposal.runId
                          }
                          onClick={() => setSelected(item.proposal.runId)}
                        >
                          <strong className={styles.rowTitle}>
                            {item.source.text?.slice(0, 90) ||
                              "Update without text"}
                          </strong>
                          <small>
                            Source {item.source.sourceId} · revision{" "}
                            {item.source.revision}
                          </small>
                        </button>
                      </li>
                    ))}
                </ul>
              </Card>
            </div>
            {entry ? (
              <div className={styles.detail}>
                <button
                  type="button"
                  className={styles.backToInbox}
                  ref={backButton}
                  onClick={() => {
                    setSelected(null);
                    requestAnimationFrame(() => searchInput.current?.focus());
                  }}
                >
                  <Icon name="arrowLeft" size={16} />
                  Back to inbox
                </button>
                <ReviewEditor
                  key={`${entry.proposal.runId}-${entry.revision}`}
                  entry={entry}
                  members={snapshot.members}
                  mutate={mutate}
                  clear={() => setSelected(null)}
                />
              </div>
            ) : (
              <div className={styles.placeholder}>
                <Icon name="arrowLeft" size={20} />
                <p>Select a source to review.</p>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
function ReviewEditor({
  entry,
  members,
  mutate,
  clear,
}: {
  entry: ReviewQueueEntry;
  members: WorkspaceSnapshot["members"];
  mutate: Mutate;
  clear: () => void;
}) {
  const [reason, setReason] = useState("");
  const [items, setItems] = useState(entry.proposal.items);
  const [pending, setPending] = useState(false);
  const [candidates, setCandidates] = useState<Array<{
    activityId: string;
    revision: number;
    reason: string;
  }> | null>(null);
  const [candidateError, setCandidateError] = useState("");
  const [links, setLinks] = useState<
    Record<string, { activityId: string; expectedRevision: number }>
  >({});
  useEffect(() => {
    let active = true;
    void request<
      Array<{ activityId: string; revision: number; reason: string }>
    >(
      `/api/product/candidates?sourceId=${encodeURIComponent(entry.source.sourceId)}`,
    ).then((result) => {
      if (!active) return;
      if (result.ok) setCandidates(result.value);
      else setCandidateError(errorMessage(result.error.code));
    });
    return () => {
      active = false;
    };
  }, [entry.source.sourceId]);
  const linked = Object.keys(links).length > 0;
  const changed =
    JSON.stringify(items) !== JSON.stringify(entry.proposal.items);
  function update(index: number, patch: object) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }
  async function decide(decision: "accept" | "reject") {
    setPending(true);
    const body = {
      runId: entry.proposal.runId,
      expectedRevision: entry.revision,
      idempotencyKey: key(),
      decision,
      reason,
      ...(decision === "accept" && changed ? { replacementItems: items } : {}),
      ...(decision === "accept" && linked ? { activityLinks: links } : {}),
    };
    if (
      await mutate(
        productEndpoints.review,
        body,
        `Proposal ${decision === "accept" ? "accepted" : "rejected"}.`,
      )
    )
      clear();
    setPending(false);
  }
  const kindTone = (kind: string) =>
    kind === "contribution"
      ? "success"
      : kind === "correction"
        ? "accent"
        : "info";
  return (
    <div className={styles.reviewPanels}>
      <Card>
        <span className={styles.eyebrow}>Source evidence</span>
        <h2>Original update</h2>
        <blockquote className={styles.quote}>
          <p className={styles.source}>
            {entry.source.text || "No text provided."}
          </p>
        </blockquote>
        <p className={styles.meta}>
          Channel: {entry.source.channel} · received{" "}
          {date(entry.source.receivedAt)} · source revision{" "}
          {entry.source.revision}
        </p>
        {entry.source.attachments?.length > 0 && (
          <section className={styles.attachments}>
            <h3>Source attachments</h3>
            <p>
              Original evidence attached to source revision{" "}
              {entry.source.revision}.
            </p>
            {entry.source.attachments.map((attachment) => (
              <figure key={attachment.id} className={styles.figure}>
                {/* The authenticated same-origin endpoint serves the original evidence without an image optimization proxy. */}
                {/* biome-ignore lint/performance/noImgElement: authenticated original evidence must use the same-origin endpoint */}
                <img
                  className={styles.attachment}
                  src={`/api/product/attachments/${encodeURIComponent(entry.source.sourceId)}/${encodeURIComponent(attachment.id)}`}
                  alt={`Source attachment ${attachment.id}, revision ${entry.source.revision}`}
                />
                <figcaption>
                  Source revision {entry.source.revision} · attachment{" "}
                  {attachment.id}
                </figcaption>
              </figure>
            ))}
          </section>
        )}
      </Card>
      <Card>
        <span className={styles.eyebrow}>Review and decide</span>
        <h2>Proposed fields</h2>
        {items.length ? (
          items.map((item, index) => (
            <div className={styles.item} key={item.key}>
              <div className={styles.itemHead}>
                <Badge tone={kindTone(item.kind)}>
                  {fieldLabel(item.kind)}
                </Badge>
              </div>
              <dl className={styles.facts}>
                {Object.entries(item)
                  .filter(
                    ([name]) => !["kind", "key", "evidence"].includes(name),
                  )
                  .map(([name, value]) => (
                    <div key={name}>
                      <dt>{fieldLabel(name)}</dt>
                      <dd>
                        {value === null ? (
                          <span className={styles.unknown}>Unknown</span>
                        ) : (
                          String(value)
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
              {item.kind === "contribution" && (
                <div className={styles.fields}>
                  <div className={styles.field}>
                    <label htmlFor={`volunteer-${index}`}>
                      Volunteer for {item.key}
                    </label>
                    <Select
                      id={`volunteer-${index}`}
                      value={item.membershipId ?? ""}
                      onChange={(e) =>
                        update(index, { membershipId: e.target.value || null })
                      }
                    >
                      <option value="">Unknown</option>
                      {item.membershipId &&
                        !members.some(
                          (m) => m.membershipId === item.membershipId,
                        ) && (
                          <option value={item.membershipId}>
                            Current member
                          </option>
                        )}
                      {members.map((m) => (
                        <option key={m.membershipId} value={m.membershipId}>
                          {m.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <label className={styles.field}>
                    Duration in minutes for {item.key}
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      value={item.durationMinutes ?? ""}
                      onChange={(e) =>
                        update(index, {
                          durationMinutes: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    />
                  </label>
                </div>
              )}
              {item.kind === "activity" && (
                <div className={styles.fields}>
                  <p className={styles.hint}>
                    Possible existing activities are suggestions; choose one
                    only after confirming it is the same activity.
                  </p>
                  <Live kind="alert">{candidateError}</Live>
                  <Live kind="polite">
                    {!candidateError && candidates === null
                      ? "Loading possible matches…"
                      : ""}
                  </Live>
                  {candidateError ||
                  candidates === null ? null : candidates.length === 0 ? (
                    <p className={styles.hint}>No possible matches.</p>
                  ) : (
                    <div className={styles.field}>
                      <label htmlFor={`link-${index}`}>
                        Link existing activity for {item.key}
                      </label>
                      <Select
                        id={`link-${index}`}
                        value={links[item.key]?.activityId ?? ""}
                        onChange={(e) => {
                          const match = candidates.find(
                            (c) => c.activityId === e.target.value,
                          );
                          setLinks((previous) => {
                            const next = { ...previous };
                            if (match)
                              next[item.key] = {
                                activityId: match.activityId,
                                expectedRevision: match.revision,
                              };
                            else delete next[item.key];
                            return next;
                          });
                        }}
                      >
                        <option value="">Do not link</option>
                        {candidates.map((c) => (
                          <option key={c.activityId} value={c.activityId}>
                            {c.activityId} · revision {c.revision} · {c.reason}
                          </option>
                        ))}
                      </Select>
                    </div>
                  )}
                  <label className={styles.field}>
                    Date for {item.key}
                    <input
                      type="date"
                      value={item.localDate ?? ""}
                      onChange={(e) =>
                        update(index, {
                          localDate: e.target.value || null,
                          datePrecision: e.target.value ? "day" : "unknown",
                        })
                      }
                    />
                  </label>
                </div>
              )}
              {item.kind === "correction" && (
                <div className={styles.fields}>
                  <p className={styles.hint}>
                    This proposed correction identifies a target and revision.
                    Check the original evidence before accepting; explain any
                    staff changes in the review reason.
                  </p>
                  <label className={styles.field}>
                    Target ID for {item.key}
                    <input
                      value={item.targetId ?? ""}
                      onChange={(e) =>
                        update(index, { targetId: e.target.value || null })
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Target revision for {item.key}
                    <input
                      type="number"
                      min="1"
                      value={item.expectedRevision ?? ""}
                      onChange={(e) =>
                        update(index, {
                          expectedRevision: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    />
                  </label>
                  <label className={styles.field}>
                    Duration in minutes for {item.key}
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      value={item.durationMinutes ?? ""}
                      onChange={(e) =>
                        update(index, {
                          durationMinutes: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    />
                  </label>
                </div>
              )}
              <p className={styles.evidenceLabel}>Original evidence:</p>
              <ul className={styles.evidence}>
                {item.evidence.map((e) => (
                  <li
                    key={`${e.field}:${e.sourceRevision}:${e.kind === "text" ? e.quote : e.observation}`}
                  >
                    {fieldLabel(e.field)}:{" "}
                    {e.kind === "text" ? `“${e.quote}”` : e.observation} (source
                    revision {e.sourceRevision})
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className={styles.hint}>No proposed fields.</p>
        )}
        {entry.proposal.unresolved.length > 0 && (
          <div className={styles.unresolved}>
            <h3>
              <Icon name="alert" size={16} />
              Unresolved in original proposal
            </h3>
            <ul>
              {entry.proposal.unresolved.map((u) => (
                <li key={`${u.field}:${u.reason}`}>
                  {fieldLabel(u.field)}: {u.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className={styles.field}>
          <label htmlFor="review-reason">
            Review reason{" "}
            {(changed || linked) && "(required for edits or links)"}
          </label>
          <textarea
            id="review-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <p className={styles.hint}>
          Incomplete contributions remain pending when accepted. Staff edits
          retain the original evidence and require a reason.
        </p>
        <div className={styles.actions}>
          <button
            className={styles.btn}
            disabled={pending || ((changed || linked) && !reason.trim())}
            type="button"
            onClick={() => void decide("accept")}
          >
            <Icon name="check" size={16} />
            Accept proposal
          </button>
          <button
            className={styles.btnDanger}
            disabled={pending || !reason.trim()}
            type="button"
            onClick={() => void decide("reject")}
          >
            <Icon name="x" size={16} />
            Reject proposal
          </button>
        </div>
        <p className={styles.hint}>
          Rejecting a proposal does not automatically withdraw a provisional
          need.
        </p>
      </Card>
    </div>
  );
}
