"use client";
import type {
  ExtractionProposal,
  Result,
  ReviewDecision,
  ReviewOutcome,
  ReviewQueueEntry,
} from "@relay/contracts";
import { reviewDecisionSchema, reviewOutcomeSchema } from "@relay/contracts";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Badge,
  Button,
  EmptyState,
  Feedback,
  Field,
  Icon,
  Select,
  TextArea,
  TextInput,
} from "../foundation";
import styles from "./review.module.css";

type ReviewProps = {
  entries: readonly ReviewQueueEntry[];
  decide: (command: ReviewDecision) => Promise<Result<ReviewOutcome>>;
  memberLabels?: Readonly<Record<string, string>>;
};

type EvidenceList = ExtractionProposal["items"][number]["evidence"];
export const humanize = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
export type SourceSpan = {
  id: string;
  label: string;
  start: number;
  end: number;
};
/** Text evidence for exactly the displayed source revision, clamped to the text; invalid spans are skipped. */
export function sourceSpans(
  items: readonly { key: string; evidence: EvidenceList }[],
  source: { sourceId: string; revision: number },
  length: number,
): SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const item of items)
    item.evidence.forEach((e, index) => {
      if (
        e.kind !== "text" ||
        e.sourceId !== source.sourceId ||
        e.sourceRevision !== source.revision ||
        !Number.isInteger(e.start) ||
        !Number.isInteger(e.end)
      )
        return;
      const start = Math.max(0, e.start);
      const end = Math.min(length, e.end);
      if (end > start)
        spans.push({
          id: evidenceId(item.key, index),
          label: humanize(e.field),
          start,
          end,
        });
    });
  return spans;
}
export const evidenceId = (itemKey: string, index: number) =>
  `${itemKey}#${index}`;
/** Splits text at span boundaries; overlaps merge into one mark covering several spans. Never alters the text. */
function segments(text: string, spans: readonly SourceSpan[]) {
  const safe = (point: number) =>
    !(
      point > 0 &&
      point < text.length &&
      /[\uDC00-\uDFFF]/.test(text.charAt(point)) &&
      /[\uD800-\uDBFF]/.test(text.charAt(point - 1))
    );
  const points = [
    ...new Set([0, text.length, ...spans.flatMap((s) => [s.start, s.end])]),
  ]
    .filter(safe)
    .sort((a, b) => a - b);
  const result: Array<{ from: number; text: string; covers: SourceSpan[] }> =
    [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i] as number;
    const to = points[i + 1] as number;
    result.push({
      from,
      text: text.slice(from, to),
      covers: spans.filter((s) => s.start <= from && s.end >= to),
    });
  }
  return result;
}
/** Active/hover provenance state shared by a source pane and its proposed fields. */
export function useProvenance() {
  const [pinned, setPinned] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const mark = root.current?.querySelector('mark[data-active="true"]');
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mark?.scrollIntoView({
      block: "nearest",
      behavior: calm ? "auto" : "smooth",
    });
  }, [pinned]);
  return {
    root,
    activeId: hover ?? pinned,
    pinned,
    preview: setHover,
    pin: useCallback(
      (id: string) => setPinned((current) => (current === id ? null : id)),
      [],
    ),
  };
}
export function HighlightedText({
  text,
  spans,
  activeId,
  preview,
  className,
  children,
}: {
  text: string;
  spans: readonly SourceSpan[];
  activeId: string | null;
  preview: (id: string | null) => void;
  className?: string | undefined;
  children?: ReactNode;
}) {
  const captionId = useId();
  const active = spans.find((s) => s.id === activeId);
  return (
    <>
      <p className={className}>
        {segments(text, spans).map((part) => {
          if (!part.covers.length)
            return <Fragment key={part.from}>{part.text}</Fragment>;
          const lead =
            part.covers.find((s) => s.id === activeId) ?? part.covers[0];
          const labels = [...new Set(part.covers.map((s) => s.label))].join(
            ", ",
          );
          return (
            <mark
              key={part.from}
              className={styles.mark}
              data-active={part.covers.some((s) => s.id === activeId)}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: focusing a highlight reveals which field it supports
              tabIndex={0}
              title={`Supports: ${labels}`}
              aria-describedby={captionId}
              onMouseEnter={() => preview(lead?.id ?? null)}
              onMouseLeave={() => preview(null)}
              onFocus={() => preview(lead?.id ?? null)}
              onBlur={() => preview(null)}
            >
              {part.text}
            </mark>
          );
        })}
      </p>
      {children}
      {spans.length > 0 && (
        <p className={styles.provenance} id={captionId}>
          {active
            ? `Highlighted passage supports: ${active.label}`
            : "Marked passages are the evidence for proposed fields."}
        </p>
      )}
    </>
  );
}
/** Keyboard shortcuts never fire while typing, with modifiers, in dialogs or while a Select is open. */
export function useShortcuts(handle: (event: KeyboardEvent) => void) {
  const latest = useRef(handle);
  latest.current = handle;
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        (target instanceof HTMLElement && target.isContentEditable) ||
        target?.closest(
          'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"], [role="listbox"], [role="textbox"], [role="dialog"]',
        ) ||
        document.querySelector(
          '[aria-expanded="true"][role="combobox"], [role="dialog"][aria-modal="true"]',
        )
      )
        return;
      latest.current(event);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
}
export function ShortcutLegend({
  open,
  onToggle,
  accept = "Accept the open proposal (when enabled)",
}: {
  open: boolean;
  onToggle: (open: boolean) => void;
  accept?: string;
}) {
  return (
    <details
      className={styles.shortcuts}
      open={open}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary>Keyboard shortcuts</summary>
      <dl>
        <dt>
          <kbd>j</kbd> / <kbd>k</kbd>
        </dt>
        <dd>Next / previous update</dd>
        <dt>
          <kbd>a</kbd>
        </dt>
        <dd>{accept}</dd>
        <dt>
          <kbd>r</kbd>
        </dt>
        <dd>Write the review reason</dd>
        <dt>
          <kbd>?</kbd>
        </dt>
        <dd>Show or hide this list</dd>
      </dl>
    </details>
  );
}
export function ReviewInbox({
  entries,
  decide,
  memberLabels = {},
}: ReviewProps) {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(
    entries[0]?.source.sourceId ?? null,
  );
  const visible = entries.filter(
    (entry) =>
      (!query ||
        `${entry.source.author.externalIdentity} ${entry.source.text}`
          .toLowerCase()
          .includes(query.toLowerCase())) &&
      (filter === "all" ||
        (filter === "urgent" &&
          entry.proposal.items.some(
            (item) => item.kind === "need" && item.urgency === "urgent",
          )) ||
        (filter === "unknown" &&
          entry.proposal.items.some(
            (item) =>
              item.kind === "contribution" && item.durationMinutes === null,
          ))),
  );
  const current = visible.find((entry) => entry.source.sourceId === selected);
  const [legend, setLegend] = useState(false);
  const sourceList = useRef<HTMLUListElement>(null);
  useShortcuts((event) => {
    if (event.key === "?") {
      event.preventDefault();
      setLegend((open) => !open);
      return;
    }
    if (event.shiftKey || (event.key !== "j" && event.key !== "k")) return;
    if (!visible.length) return;
    event.preventDefault();
    const index = visible.findIndex(
      (entry) => entry.source.sourceId === selected,
    );
    const next =
      event.key === "j"
        ? visible[Math.min(visible.length - 1, index + 1)]
        : visible[index < 0 ? visible.length - 1 : Math.max(0, index - 1)];
    if (!next) return;
    setSelected(next.source.sourceId);
    requestAnimationFrame(() =>
      sourceList.current
        ?.querySelector('[aria-pressed="true"]')
        ?.scrollIntoView({ block: "nearest" }),
    );
  });
  return (
    <div className={styles.review}>
      <div className={styles.filters}>
        <Field id="review-filter" label="Show updates">
          <Select
            id="review-filter"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setSelected(null);
            }}
          >
            <option value="all">All updates</option>
            <option value="urgent">Urgent needs</option>
            <option value="unknown">Unknown duration</option>
          </Select>
        </Field>
        <Field id="review-search" label="Search synthetic updates">
          <TextInput
            id="review-search"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
          />
        </Field>
      </div>
      <div className={styles.workspace}>
        <section className={styles.sourceList} aria-labelledby="queue-heading">
          <h2 id="queue-heading">Source inbox</h2>
          <p>Pending review · synthetic fixtures</p>
          <ShortcutLegend open={legend} onToggle={setLegend} />
          <ul className={styles.list} ref={sourceList}>
            {visible.map((entry) => (
              <li key={entry.source.sourceId}>
                <button
                  type="button"
                  className={styles.sourceButton}
                  aria-pressed={
                    current?.source.sourceId === entry.source.sourceId
                  }
                  onClick={() => setSelected(entry.source.sourceId)}
                >
                  <strong>{entry.source.author.externalIdentity}</strong>
                  <span>{entry.source.text}</span>
                  <span>
                    <Badge tone="warning">Pending review</Badge> ·{" "}
                    {entry.source.channel}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!visible.length && (
            <EmptyState title="No matching updates" icon="search">
              Change the filters to see other sources.
            </EmptyState>
          )}
        </section>
        {current ? (
          <ReviewDetail
            key={`${current.source.sourceId}:${current.revision}:${filter}:${query}`}
            entry={current}
            decide={decide}
            memberLabels={memberLabels}
          />
        ) : (
          <div className={styles.noSelection}>
            <EmptyState title="Select an update" icon="inbox">
              Choose a visible source to see its evidence and proposals.
            </EmptyState>
          </div>
        )}
      </div>
    </div>
  );
}
type Provenance = ReturnType<typeof useProvenance>;
function ProposalItem({
  item,
  labels,
  provenance,
  spans,
}: {
  item: ExtractionProposal["items"][number];
  labels: Readonly<Record<string, string>>;
  provenance: Provenance;
  spans: readonly SourceSpan[];
}) {
  return (
    <article className={styles.proposal}>
      <h3>
        {item.kind === "activity"
          ? item.activityKind
          : item.kind === "contribution"
            ? "Contribution candidate"
            : item.kind === "need"
              ? "Need candidate"
              : "Correction candidate"}
      </h3>
      {item.kind === "activity" && (
        <dl>
          <dt>Date</dt>
          <dd className={item.localDate ? undefined : styles.unknown}>
            {item.localDate ?? "Unknown date"}
          </dd>
          <dt>Beneficiary reference</dt>
          <dd
            className={item.beneficiaryReference ? undefined : styles.unknown}
          >
            {item.beneficiaryReference ?? "Unknown reference"}
          </dd>
        </dl>
      )}
      {item.kind === "contribution" && (
        <dl>
          <dt>Volunteer</dt>
          <dd className={item.membershipId ? undefined : styles.unknown}>
            {item.membershipId
              ? (labels[item.membershipId] ?? item.membershipId)
              : "Unresolved volunteer"}
          </dd>
          <dt>Duration</dt>
          <dd
            className={
              item.durationMinutes === null ? styles.unknown : undefined
            }
          >
            {item.durationMinutes === null
              ? "Unknown duration"
              : `${item.durationMinutes} minutes`}
          </dd>
          <dt>Activity candidate</dt>
          <dd>{item.activityKey}</dd>
        </dl>
      )}
      {item.kind === "need" && (
        <>
          <Badge tone={item.urgency === "urgent" ? "danger" : "neutral"}>
            {item.urgency === "urgent" ? "Urgent" : "Routine"}
          </Badge>{" "}
          <Badge tone={item.provisional ? "warning" : "neutral"}>
            {item.provisional
              ? "Provisional alert · unverified"
              : "Awaiting review"}
          </Badge>
          <p>{item.summary}</p>
          <p>{item.category}</p>
        </>
      )}
      {item.kind === "correction" && (
        <>
          <p>{item.reason}</p>
          <p
            className={
              item.durationMinutes === null ? styles.unknown : undefined
            }
          >
            {item.durationMinutes === null
              ? "Unknown duration"
              : `${item.durationMinutes} minutes`}
          </p>
          <p>Correction actions are unavailable in this preview.</p>
        </>
      )}
      <details>
        <summary>Field evidence</summary>
        {item.evidence.map((e, index) => (
          <div
            key={`${e.field}:${e.sourceId}:${e.sourceRevision}:${e.kind === "text" ? `${e.start}:${e.end}` : e.attachmentId}`}
            className={styles.evidence}
          >
            <strong>{e.field}</strong>
            {e.kind === "text" ? (
              <>
                <blockquote className={styles.quote}>{e.quote}</blockquote>
                <small>
                  Source {e.sourceId}, revision {e.sourceRevision} · characters{" "}
                  {e.start}–{e.end}
                </small>
                {spans.some((s) => s.id === evidenceId(item.key, index)) && (
                  <button
                    type="button"
                    className={styles.showInSource}
                    aria-pressed={
                      provenance.pinned === evidenceId(item.key, index)
                    }
                    aria-label={`Show in source: ${humanize(e.field)}`}
                    onClick={() => provenance.pin(evidenceId(item.key, index))}
                    onFocus={() =>
                      provenance.preview(evidenceId(item.key, index))
                    }
                    onBlur={() => provenance.preview(null)}
                  >
                    <Icon name="search" size={16} />
                    Show in source
                  </button>
                )}
              </>
            ) : (
              <p>
                {e.observation} · attachment {e.attachmentId}
              </p>
            )}
          </div>
        ))}
      </details>
    </article>
  );
}
function ReviewDetail({
  entry,
  decide,
  memberLabels,
}: {
  entry: ReviewQueueEntry;
  decide: ReviewProps["decide"];
  memberLabels: Readonly<Record<string, string>>;
}) {
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const actionRegion = useRef<HTMLDivElement>(null);
  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [completedDecision, setCompletedDecision] = useState<
    ReviewDecision["decision"] | null
  >(null);
  const locked = useRef(false);
  const previousCommand = useRef<ReviewDecision | null>(null);
  const resultRegion = useRef<HTMLDivElement>(null);
  const provenance = useProvenance();
  const spans = sourceSpans(
    entry.proposal.items,
    entry.source,
    entry.source.text.length,
  );
  useEffect(() => {
    if (outcome) resultRegion.current?.focus();
  }, [outcome]);
  const blocked =
    entry.proposal.unresolved.length > 0 ||
    entry.proposal.items.some(
      (item) =>
        item.kind === "correction" ||
        (item.kind === "contribution" &&
          (item.durationMinutes === null || item.membershipId === null)),
    );
  async function decideNow(decision: ReviewDecision["decision"]) {
    if (
      locked.current ||
      outcome ||
      conflict ||
      (decision === "accept" && blocked)
    )
      return;
    if (decision === "reject" && !reason.trim()) {
      setError("Add a reason before rejecting this proposal.");
      actionRegion.current?.querySelector("textarea")?.focus();
      return;
    }
    const prior = previousCommand.current;
    const parsed = reviewDecisionSchema.safeParse(
      prior && prior.decision === decision && prior.reason === reason
        ? prior
        : {
            runId: entry.proposal.runId,
            expectedRevision: entry.revision,
            idempotencyKey: crypto.randomUUID(),
            decision,
            reason,
          },
    );
    if (!parsed.success) {
      setError("Check the review reason and try again.");
      return;
    }
    const command = parsed.data;
    previousCommand.current = command;
    locked.current = true;
    setPending(true);
    setError("");
    try {
      const result = await decide(command);
      if (result.ok) {
        setOutcome(reviewOutcomeSchema.parse(result.value));
        setCompletedDecision(decision);
      } else {
        setConflict(result.error.code === "CONFLICT");
        setError(
          result.error.code === "CONFLICT"
            ? "This review changed. Reload the preview before trying again; your decision was not applied."
            : "The simulated review failed. Your reason is still here; try again.",
        );
      }
    } catch {
      setError(
        "The simulated review failed. Your reason is still here; try again.",
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  useShortcuts((event) => {
    if (event.shiftKey || outcome) return;
    if (event.key === "a" && !(pending || blocked || conflict)) {
      event.preventDefault();
      void decideNow("accept");
    } else if (event.key === "r" && !pending) {
      event.preventDefault();
      actionRegion.current?.querySelector("textarea")?.focus();
    }
  });
  return (
    <div className={styles.detail}>
      <section className={styles.sourcePane} ref={provenance.root}>
        <h2>Original source</h2>
        <Badge>{entry.source.author.externalIdentity}</Badge>
        <p>
          Source revision {entry.source.revision} · {entry.source.timezone}
        </p>
        <blockquote className={styles.sourceText}>
          <HighlightedText
            text={entry.source.text}
            spans={spans}
            activeId={provenance.activeId}
            preview={provenance.preview}
          />
        </blockquote>
        <p>Preserved evidence · proposals below are unverified.</p>
      </section>
      <section className={styles.proposals} aria-labelledby="proposals-heading">
        <h2 id="proposals-heading">Proposed records</h2>
        <p>Review revision {entry.revision} · independent of source revision</p>
        {entry.proposal.items.map((item) => (
          <ProposalItem
            key={item.key}
            item={item}
            labels={memberLabels}
            provenance={provenance}
            spans={spans}
          />
        ))}
        {!entry.proposal.items.length && (
          <EmptyState title="No record candidates">
            Only source evidence and unresolved questions are available.
          </EmptyState>
        )}
        {entry.proposal.unresolved.length > 0 && (
          <div className={styles.unresolved}>
            <strong>
              <Icon name="alert" size={16} />
              Clarification or reconciliation needed
            </strong>
            {entry.proposal.unresolved.map((issue) => (
              <span
                className={styles.issue}
                key={`${issue.field}:${issue.reason}`}
              >
                {issue.reason}
              </span>
            ))}
          </div>
        )}
        <div
          ref={actionRegion}
          className={styles.decisions}
          aria-busy={pending}
        >
          {outcome ? (
            <div ref={resultRegion} tabIndex={-1}>
              <Feedback
                title={`Simulated ${completedDecision === "accept" ? "acceptance" : "rejection"} — no data saved`}
              >
                Preview review revision {outcome.revision}. No ledger entries,
                assignments or alerts were changed.
              </Feedback>
            </div>
          ) : (
            <>
              <Field
                id="review-reason"
                label="Review reason"
                hint="Required for rejection. Kept only for this selected preview."
                error={error}
              >
                <TextArea
                  id="review-reason"
                  value={reason}
                  disabled={pending}
                  aria-invalid={Boolean(error)}
                  aria-describedby={`review-reason-hint${error ? " review-reason-error" : ""}`}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setError("");
                  }}
                />
              </Field>
              {blocked && (
                <p>
                  Acceptance unavailable until unresolved details are
                  reconciled. Edit and link actions are not part of this
                  preview.
                </p>
              )}
              {error && (
                <Feedback tone="danger" title="Preview decision not applied">
                  {error}
                </Feedback>
              )}
              {conflict && (
                <Button
                  variant="secondary"
                  onClick={() => window.location.reload()}
                >
                  Reload preview
                </Button>
              )}
              {pending && (
                <Feedback title="Applying simulated decision…">
                  No data is being saved.
                </Feedback>
              )}
              <div className={styles.actions}>
                <Button
                  disabled={pending || blocked || conflict}
                  onClick={() => decideNow("accept")}
                >
                  Accept preview
                </Button>
                <Button
                  variant="danger"
                  className={styles.reject}
                  disabled={pending || conflict}
                  onClick={() => decideNow("reject")}
                >
                  Reject preview
                </Button>
              </div>
            </>
          )}
          <p>
            Rejecting a proposal does not withdraw a provisional alert. Source
            evidence is retained in this view; no real messages or notifications
            are sent.
          </p>
        </div>
      </section>
    </div>
  );
}
