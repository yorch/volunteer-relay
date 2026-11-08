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
import { ShortcutLegend, useShortcuts } from "../review";
import { DemoReplay } from "./demo-replay";
import styles from "./inbox.module.css";
import {
  authorName,
  buildSegments,
  countUnknown,
  deriveFlags,
  fieldDisplayLabel,
  flagLabels,
  type InboxFlag,
  relativeTime,
  resolveEvidenceRange,
  type TextRange,
} from "./inbox-helpers";
import { date, duration, key, type Mutate, PendingSource } from "./shared";

const flagTone = (flag: InboxFlag) =>
  flag === "urgent" || flag === "duplicate"
    ? "danger"
    : flag === "photo"
      ? "info"
      : "warning";

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
  const visibleQueue = snapshot.queue.filter((item) =>
    `${item.source.sourceId} ${item.source.text ?? ""} ${authorName(item.source.author, snapshot.members)} ${item.source.channel}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const [legend, setLegend] = useState(false);
  const [lastDecision, setLastDecision] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  useShortcuts((event) => {
    if (statusFilter !== "review") return;
    if (event.key === "?") {
      event.preventDefault();
      setLegend((open) => !open);
      return;
    }
    if (event.shiftKey || (event.key !== "j" && event.key !== "k")) return;
    if (!visibleQueue.length) return;
    event.preventDefault();
    const index = visibleQueue.findIndex(
      (item) => item.proposal.runId === selected,
    );
    const next =
      event.key === "j"
        ? visibleQueue[Math.min(visibleQueue.length - 1, index + 1)]
        : visibleQueue[
            index < 0 ? visibleQueue.length - 1 : Math.max(0, index - 1)
          ];
    if (!next) return;
    setSelected(next.proposal.runId);
    setLastDecision("");
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector('[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
  });
  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <h1>Source inbox</h1>
        <p>Review the original update alongside its proposed fields.</p>
      </header>
      <DemoReplay mutate={mutate} />
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
      {statusFilter === "review" && snapshot.queue.length > 0 && (
        <ShortcutLegend
          open={legend}
          onToggle={setLegend}
          accept="Accept the open proposal (when enabled)"
        />
      )}
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
            {lastDecision && (
              <p className={styles.decisionNote} aria-hidden="true">
                {lastDecision}
              </p>
            )}
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
                <ul className={`${styles.list}`} ref={listRef}>
                  {visibleQueue.map((item) => {
                    const flags = deriveFlags(item.source, item.proposal.items);
                    return (
                      <li key={item.proposal.runId}>
                        <button
                          type="button"
                          className={styles.row}
                          data-tone="review"
                          aria-pressed={
                            entry?.proposal.runId === item.proposal.runId
                          }
                          onClick={() => {
                            setSelected(item.proposal.runId);
                            setLastDecision("");
                          }}
                        >
                          <strong className={styles.rowTitle}>
                            {item.source.text?.slice(0, 90) ||
                              "Update without text"}
                          </strong>
                          <span className={styles.rowMeta}>
                            <span className={styles.rowAuthor}>
                              {authorName(item.source.author, snapshot.members)}
                            </span>
                            <span>{relativeTime(item.source.receivedAt)}</span>
                            <span>{item.source.channel}</span>
                          </span>
                          <small>
                            Source {item.source.sourceId} · revision{" "}
                            {item.source.revision}
                          </small>
                          {flags.length > 0 && (
                            <span className={styles.flags}>
                              {flags.map((flag) => (
                                <span
                                  key={flag}
                                  className={styles.flag}
                                  data-tone={flagTone(flag)}
                                >
                                  {flagLabels[flag]}
                                </span>
                              ))}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
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
                  clear={(message) => {
                    setSelected(null);
                    setLastDecision(message);
                  }}
                />
              </div>
            ) : (
              <div className={styles.placeholder}>
                <Icon name="arrowLeft" size={20} />
                <p>Select a source to review.</p>
                {lastDecision && (
                  <p className={styles.decisionNote} aria-hidden="true">
                    {lastDecision}
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
function Lightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    // The native dialog traps focus and closes on Escape; the backdrop click
    // is a pointer convenience, the Close button is the keyboard path.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape and the Close button cover the keyboard path
    <dialog
      ref={dialog}
      className={styles.lightbox}
      aria-label="Enlarged photo"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className={styles.lightboxBody}>
        <button
          type="button"
          className={styles.btnSecondary}
          onClick={() => dialog.current?.close()}
        >
          <Icon name="x" size={16} />
          Close photo
        </button>
        {/* biome-ignore lint/performance/noImgElement: authenticated original evidence must use the same-origin endpoint */}
        <img className={styles.lightboxImage} src={src} alt={alt} />
      </div>
    </dialog>
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
  clear: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [items, setItems] = useState(entry.proposal.items);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const reasonField = useRef<HTMLTextAreaElement>(null);
  const [candidates, setCandidates] = useState<Array<{
    activityId: string;
    revision: number;
    reason: string;
  }> | null>(null);
  const [candidateError, setCandidateError] = useState("");
  const [links, setLinks] = useState<
    Record<string, { activityId: string; expectedRevision: number }>
  >({});
  const [activeEv, setActiveEv] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const lightboxTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
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
  const original = (itemKey: string) =>
    entry.proposal.items.find((o) => o.key === itemKey) as
      | Record<string, unknown>
      | undefined;
  const editedFields = items.reduce((total, item) => {
    const before = original(item.key);
    if (!before) return total;
    return (
      total +
      Object.entries(item).filter(
        ([name, value]) =>
          name !== "evidence" &&
          JSON.stringify(before[name]) !== JSON.stringify(value),
      ).length
    );
  }, 0);
  const edited = changed || linked;
  const invalid = items.some(
    (item) =>
      item.kind === "need" && (!item.category.trim() || !item.summary.trim()),
  );
  const canAccept = !(
    pending ||
    invalid ||
    ((changed || linked) && !reason.trim())
  );
  useShortcuts((event) => {
    if (event.shiftKey) return;
    if (event.key === "a" && canAccept) {
      event.preventDefault();
      void decide("accept");
    } else if (event.key === "r") {
      event.preventDefault();
      reasonField.current?.focus();
    }
  });
  const unknownCount = countUnknown(items);
  const duplicateCount = candidates?.length ?? 0;
  const flags = deriveFlags(entry.source, items, duplicateCount);
  const sourceText = entry.source.text;
  const ranges: TextRange[] = items.flatMap((item, index) =>
    item.evidence.flatMap((e, i) => {
      if (e.kind !== "text" || e.sourceRevision !== entry.source.revision)
        return [];
      const range = resolveEvidenceRange(sourceText, e);
      return range ? [{ id: `ev-${index}-${i}`, ...range }] : [];
    }),
  );
  let offset = 0;
  const segments = buildSegments(sourceText, ranges).map((segment) => {
    const start = offset;
    offset += segment.text.length;
    return { ...segment, start };
  });
  function reveal(id: string, attachmentId?: string) {
    clearTimeout(flashTimer.current);
    setActiveEv(null);
    requestAnimationFrame(() => {
      setActiveEv(id);
      const root = sourceRef.current;
      const target = attachmentId
        ? Array.from(
            root?.querySelectorAll<HTMLElement>("[data-att]") ?? [],
          ).find((el) => el.dataset.att === attachmentId)
        : root?.querySelector<HTMLElement>(`[data-ev~="${id}"]`);
      target?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
      flashTimer.current = setTimeout(() => setActiveEv(null), 2200);
    });
  }
  function update(index: number, patch: object) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }
  async function decide(decision: "accept" | "reject") {
    setPending(true);
    setFailed(false);
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
      clear(
        `${decision === "accept" ? "Proposal accepted" : "Proposal rejected"} for source ${entry.source.sourceId}. Press j or k to open the next update.`,
      );
    else setFailed(true);
    setPending(false);
  }
  const kindTone = (kind: string) =>
    kind === "contribution"
      ? "success"
      : kind === "correction"
        ? "accent"
        : "info";
  const kindLabel = (kind: string) =>
    kind === "activity"
      ? "Activity"
      : kind === "contribution"
        ? "Contribution"
        : kind === "need"
          ? "Need"
          : "Correction";
  function factValue(name: string, value: unknown): ReactNode {
    if (value === null || (name === "datePrecision" && value === "unknown"))
      return <span className={styles.unknown}>Unknown</span>;
    if (name === "membershipId")
      return (
        members.find((m) => m.membershipId === value)?.name ??
        "Member not in directory"
      );
    if (name === "durationMinutes" && typeof value === "number")
      return duration(value);
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (name === "urgency")
      return value === "urgent" ? (
        <Badge tone="danger">Urgent</Badge>
      ) : (
        "Routine"
      );
    if (name === "datePrecision")
      return value === "day" ? "Exact day" : String(value);
    return String(value);
  }
  const hint = edited
    ? reason.trim()
      ? "Your edits are accepted together with the original evidence."
      : "You edited this proposal. Add a review reason to accept it."
    : reason.trim()
      ? "Your reason is recorded with the decision."
      : "A reason is required to reject; it is optional to accept as proposed.";
  const hintId = "review-action-hint";
  const attachmentSrc = (id: string) =>
    `/api/product/attachments/${encodeURIComponent(entry.source.sourceId)}/${encodeURIComponent(id)}`;
  const author = entry.source.author;
  const authorMember = author?.membershipId
    ? members.find((m) => m.membershipId === author.membershipId)
    : undefined;
  return (
    <div className={styles.reviewPanels}>
      <Card>
        <div className={styles.sourcePane} ref={sourceRef}>
          <span className={styles.eyebrow}>Source evidence</span>
          <h2>Original update</h2>
          <dl className={styles.sourceMeta}>
            <div>
              <dt>Author</dt>
              <dd>
                {authorName(author, members)}
                {authorMember && author && (
                  <span className={styles.muted}>
                    {" "}
                    · {author.externalIdentity}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Received</dt>
              <dd>
                {date(entry.source.receivedAt)}{" "}
                <span className={styles.muted}>
                  ({relativeTime(entry.source.receivedAt)})
                </span>
              </dd>
            </div>
            {entry.source.occurredAt && (
              <div>
                <dt>Occurred</dt>
                <dd>
                  {date(entry.source.occurredAt)}{" "}
                  <span className={styles.muted}>
                    ({entry.source.timezone})
                  </span>
                </dd>
              </div>
            )}
            <div>
              <dt>Channel</dt>
              <dd>
                {entry.source.channel} · source revision {entry.source.revision}
              </dd>
            </div>
          </dl>
          <blockquote className={styles.quote}>
            <p className={styles.source}>
              {sourceText
                ? segments.map((segment) =>
                    segment.ids.length ? (
                      <mark
                        key={segment.start}
                        className={styles.mark}
                        data-ev={segment.ids.join(" ")}
                        data-active={
                          activeEv && segment.ids.includes(activeEv)
                            ? "true"
                            : undefined
                        }
                      >
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={segment.start}>{segment.text}</span>
                    ),
                  )
                : "No text provided."}
            </p>
          </blockquote>
          {ranges.length > 0 && (
            <p className={styles.hint}>
              Highlighted passages are the evidence for the proposed fields.
            </p>
          )}
          {entry.source.attachments?.length > 0 && (
            <section className={styles.attachments}>
              <h3>Source attachments</h3>
              <p>
                Original evidence attached to source revision{" "}
                {entry.source.revision}.
              </p>
              {entry.source.attachments.map((attachment) => {
                const cites = items.flatMap((item, index) =>
                  item.evidence.flatMap((e, i) =>
                    e.kind === "attachment" && e.attachmentId === attachment.id
                      ? [{ id: `ev-${index}-${i}`, field: e.field }]
                      : [],
                  ),
                );
                return (
                  <figure
                    key={attachment.id}
                    className={styles.figure}
                    data-att={attachment.id}
                    data-active={
                      activeEv && cites.some((c) => c.id === activeEv)
                        ? "true"
                        : undefined
                    }
                  >
                    <div className={styles.photo}>
                      {/* The authenticated same-origin endpoint serves the original evidence without an image optimization proxy. */}
                      {/* biome-ignore lint/performance/noImgElement: authenticated original evidence must use the same-origin endpoint */}
                      <img
                        className={styles.attachment}
                        src={attachmentSrc(attachment.id)}
                        alt={`Source attachment ${attachment.id}, revision ${entry.source.revision}`}
                      />
                      <button
                        type="button"
                        className={styles.enlarge}
                        aria-label={`Enlarge photo ${attachment.id}`}
                        onClick={(event) => {
                          lightboxTrigger.current = event.currentTarget;
                          setEnlarged(attachment.id);
                        }}
                      >
                        <Icon name="search" size={16} />
                        <span>Enlarge</span>
                      </button>
                    </div>
                    <figcaption>
                      Source revision {entry.source.revision} · attachment{" "}
                      {attachment.id}
                    </figcaption>
                    {cites.length > 0 && (
                      <p className={styles.cites}>
                        Evidence for:{" "}
                        {cites.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            className={styles.citeChip}
                            onClick={() => reveal(c.id, attachment.id)}
                          >
                            {fieldDisplayLabel(c.field)}
                          </button>
                        ))}
                      </p>
                    )}
                  </figure>
                );
              })}
            </section>
          )}
        </div>
      </Card>
      {enlarged && (
        <Lightbox
          src={attachmentSrc(enlarged)}
          alt={`Source attachment ${enlarged}, revision ${entry.source.revision}`}
          onClose={() => {
            setEnlarged(null);
            const trigger = lightboxTrigger.current;
            requestAnimationFrame(() => trigger?.focus());
          }}
        />
      )}
      <Card>
        <span className={styles.eyebrow}>Review and decide</span>
        <h2>Proposed fields</h2>
        <div className={styles.summaryBadges}>
          {unknownCount > 0 && (
            <Badge tone="warning">{unknownCount} unknown</Badge>
          )}
          {duplicateCount > 0 && (
            <Badge tone="danger">Duplicate candidate</Badge>
          )}
          {flags.includes("urgent") && <Badge tone="danger">Urgent need</Badge>}
          {edited && (
            <Badge tone="accent">
              Edited
              {editedFields > 0
                ? ` · ${editedFields} field${editedFields === 1 ? "" : "s"}`
                : ""}
              {linked ? " · linked" : ""}
            </Badge>
          )}
        </div>
        {duplicateCount > 0 && candidates && (
          <div className={styles.duplicate}>
            <h3>
              <Icon name="alert" size={16} />
              Possible duplicate of an existing activity
            </h3>
            <p>
              {duplicateCount} possible match{duplicateCount === 1 ? "" : "es"}:{" "}
              {candidates[0]?.reason}
              {duplicateCount > 1 ? ` (and ${duplicateCount - 1} more)` : ""}.
              Link one below only after confirming it is the same activity.
            </p>
          </div>
        )}
        {items.length ? (
          items.map((item, index) => {
            const before = original(item.key);
            return (
              <div className={styles.item} key={item.key}>
                <div className={styles.itemHead}>
                  <Badge tone={kindTone(item.kind)}>
                    {kindLabel(item.kind)}
                  </Badge>
                </div>
                <dl className={styles.facts}>
                  {Object.entries(item)
                    .filter(
                      ([name]) => !["kind", "key", "evidence"].includes(name),
                    )
                    .map(([name, value]) => {
                      const isEdited =
                        before !== undefined &&
                        JSON.stringify(before[name]) !== JSON.stringify(value);
                      return (
                        <div key={name}>
                          <dt>{fieldDisplayLabel(name)}</dt>
                          <dd>
                            {factValue(name, value)}
                            {isEdited && (
                              <span className={styles.editedTag}>edited</span>
                            )}
                          </dd>
                        </div>
                      );
                    })}
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
                          update(index, {
                            membershipId: e.target.value || null,
                          })
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
                              {c.activityId} · revision {c.revision} ·{" "}
                              {c.reason}
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
                {item.kind === "need" && (
                  <div className={styles.fields}>
                    <p className={styles.hint}>
                      Needs stay provisional until staff confirm them. Edit the
                      wording here; explain changes in the review reason.
                    </p>
                    <label className={styles.field}>
                      Category for {item.key}
                      <input
                        value={item.category}
                        onChange={(e) =>
                          update(index, { category: e.target.value })
                        }
                      />
                    </label>
                    <div className={styles.field}>
                      <label htmlFor={`urgency-${index}`}>
                        Urgency for {item.key}
                      </label>
                      <Select
                        id={`urgency-${index}`}
                        value={item.urgency}
                        onChange={(e) =>
                          update(index, { urgency: e.target.value })
                        }
                      >
                        <option value="routine">Routine</option>
                        <option value="urgent">Urgent</option>
                      </Select>
                    </div>
                    <label className={styles.field}>
                      Summary for {item.key}
                      <textarea
                        value={item.summary}
                        onChange={(e) =>
                          update(index, { summary: e.target.value })
                        }
                      />
                    </label>
                    <label className={styles.checkField}>
                      <input
                        type="checkbox"
                        checked={item.provisional}
                        onChange={(e) =>
                          update(index, { provisional: e.target.checked })
                        }
                      />
                      Provisional need for {item.key}
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
                  {item.evidence.map((e, i) => {
                    const id = `ev-${index}-${i}`;
                    return (
                      <li
                        key={`${e.field}:${e.sourceRevision}:${e.kind === "text" ? e.quote : e.observation}`}
                        data-active={activeEv === id ? "true" : undefined}
                        data-kind={e.kind}
                      >
                        <button
                          type="button"
                          className={styles.evidenceButton}
                          onClick={() =>
                            reveal(
                              id,
                              e.kind === "attachment"
                                ? e.attachmentId
                                : undefined,
                            )
                          }
                        >
                          {fieldLabel(e.field)}:{" "}
                          {e.kind === "text" ? `“${e.quote}”` : e.observation}{" "}
                          (source revision {e.sourceRevision})
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })
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
            ref={reasonField}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <p className={styles.hint}>
          Incomplete contributions remain pending when accepted. Staff edits
          retain the original evidence and require a reason. Rejecting a
          proposal does not automatically withdraw a provisional need.
        </p>
        <section
          className={styles.actionBar}
          aria-label="Review decision"
          data-edited={edited ? "true" : undefined}
        >
          <p id={hintId} className={styles.actionHint}>
            {edited && <Badge tone="accent">Edited</Badge>} {hint}
          </p>
          <div className={styles.actions}>
            <button
              className={styles.btn}
              aria-describedby={hintId}
              disabled={!canAccept}
              type="button"
              onClick={() => void decide("accept")}
            >
              <Icon name="check" size={16} />
              Accept proposal
            </button>
            <button
              className={styles.btnDanger}
              aria-describedby={hintId}
              disabled={pending || !reason.trim()}
              type="button"
              onClick={() => void decide("reject")}
            >
              <Icon name="x" size={16} />
              Reject proposal
            </button>
          </div>
          <p className={styles.decisionNote} aria-hidden="true">
            {pending
              ? "Sending your decision…"
              : failed
                ? "Decision not applied. Your reason is kept; check the message above and try again."
                : "Shortcuts: a accepts, r writes the reason, ? lists all."}
          </p>
        </section>
      </Card>
    </div>
  );
}
