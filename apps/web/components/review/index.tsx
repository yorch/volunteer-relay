"use client";
import type {
  ExtractionProposal,
  Result,
  ReviewDecision,
  ReviewOutcome,
  ReviewQueueEntry,
} from "@relay/contracts";
import { reviewDecisionSchema, reviewOutcomeSchema } from "@relay/contracts";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Feedback,
  Field,
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
  return (
    <>
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
          <ul className={styles.list}>
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
            <EmptyState title="No matching updates">
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
            <EmptyState title="Select an update">
              Choose a visible source to see its evidence and proposals.
            </EmptyState>
          </div>
        )}
      </div>
    </>
  );
}
function ProposalItem({
  item,
  labels,
}: {
  item: ExtractionProposal["items"][number];
  labels: Readonly<Record<string, string>>;
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
          <dd>{item.localDate ?? "Unknown date"}</dd>
          <dt>Beneficiary reference</dt>
          <dd>{item.beneficiaryReference ?? "Unknown reference"}</dd>
        </dl>
      )}
      {item.kind === "contribution" && (
        <dl>
          <dt>Volunteer</dt>
          <dd>
            {item.membershipId
              ? (labels[item.membershipId] ?? item.membershipId)
              : "Unresolved volunteer"}
          </dd>
          <dt>Duration</dt>
          <dd>
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
          <p>
            {item.durationMinutes === null
              ? "Unknown duration"
              : `${item.durationMinutes} minutes`}
          </p>
          <p>Correction actions are unavailable in this preview.</p>
        </>
      )}
      <details>
        <summary>Field evidence</summary>
        {item.evidence.map((e) => (
          <div
            key={`${e.field}:${e.sourceId}:${e.sourceRevision}:${e.kind === "text" ? `${e.start}:${e.end}` : e.attachmentId}`}
            className={styles.evidence}
          >
            <strong>{e.field}</strong>
            {e.kind === "text" ? (
              <>
                <blockquote>{e.quote}</blockquote>
                <small>
                  Source {e.sourceId}, revision {e.sourceRevision} · characters{" "}
                  {e.start}–{e.end}
                </small>
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
    const command = reviewDecisionSchema.parse(
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
  return (
    <div className={styles.detail}>
      <Card title="Original source">
        <Badge>{entry.source.author.externalIdentity}</Badge>
        <p>
          Source revision {entry.source.revision} · {entry.source.timezone}
        </p>
        <blockquote className={styles.sourceText}>
          {entry.source.text}
        </blockquote>
        <p>Preserved evidence · proposals below are unverified.</p>
      </Card>
      <section className={styles.proposals} aria-labelledby="proposals-heading">
        <h2 id="proposals-heading">Proposed records</h2>
        <p>Review revision {entry.revision} · independent of source revision</p>
        {entry.proposal.items.map((item) => (
          <ProposalItem key={item.key} item={item} labels={memberLabels} />
        ))}
        {!entry.proposal.items.length && (
          <EmptyState title="No record candidates">
            Only source evidence and unresolved questions are available.
          </EmptyState>
        )}
        {entry.proposal.unresolved.length > 0 && (
          <Feedback
            tone="warning"
            title="Clarification or reconciliation needed"
          >
            {entry.proposal.unresolved.map((issue) => (
              <span
                className={styles.issue}
                key={`${issue.field}:${issue.reason}`}
              >
                {issue.reason}
              </span>
            ))}
          </Feedback>
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
                  variant="secondary"
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
