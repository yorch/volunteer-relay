"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { request } from "../api-client";
import { Card, Live } from "../card";
import { Button, Icon, TextArea } from "../foundation";
import styles from "./retention.module.css";

type Preview = {
  cutoff: string;
  truncated: boolean;
  sources: Array<{
    sourceId: string;
    latestRevision: number;
    expiredRevisions: number;
    attachmentCount: number;
  }>;
};
type Mutate = (
  endpoint: string,
  body: object,
  success: string,
) => Promise<boolean>;
export function Retention({ mutate }: { mutate: Mutate }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await request<Preview>("/api/product/retention-preview");
    if (result.ok) {
      setPreview(result.value);
      setError("");
    } else {
      setPreview(null);
      setError(
        result.error.code === "FORBIDDEN"
          ? "You do not have permission to view retention."
          : "Unable to load retention preview.",
      );
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const source = preview?.sources.find((s) => s.sourceId === selected);
  async function redact(e: FormEvent) {
    e.preventDefault();
    if (!source || !ack || !reason.trim()) return;
    setPending(true);
    if (
      await mutate(
        "/api/product/retention-redact",
        {
          sourceId: source.sourceId,
          expectedRevision: source.latestRevision,
          reason,
        },
        "Source evidence redacted.",
      )
    ) {
      setSelected(null);
      setReason("");
      setAck(false);
      await refresh();
    }
    setPending(false);
  }
  function chooseSource(sourceId: string) {
    setSelected((current) => (current === sourceId ? null : sourceId));
    setReason("");
    setAck(false);
  }
  return (
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>PRIVACY AND RETENTION</p>
          <h1>Retention review</h1>
          <p>
            Review evidence that has passed the organization’s retention period.
          </p>
        </div>
      </header>
      <div className={styles.retentionNotice}>
        <span aria-hidden="true">
          <Icon name="alert" size={20} />
        </span>
        <p>
          <strong>Redaction is permanent.</strong> It removes raw source and
          derived data and queues private file erasure. Approved numeric ledger
          records remain. Review each candidate and record a reason before
          confirming.
        </p>
      </div>
      <div className={styles.retentionTools}>
        <a className={styles.ledgerLink} href="/api/product/retention-ledger">
          Download signed retention ledger
          <Icon name="download" size={16} />
        </a>
        <p>
          The signed ledger records completed retention actions for later
          review.
        </p>
      </div>
      <Live kind="polite" className={styles.loading}>
        {loading ? "Loading eligible evidence…" : ""}
      </Live>
      <Live kind="alert" className={styles.error}>
        {loading ? "" : error}
      </Live>
      {loading ? null : error ? (
        <Card className={styles.card}>
          <Button variant="secondary" onClick={() => void refresh()}>
            Try again
          </Button>
        </Card>
      ) : (
        preview && (
          <>
            <section
              className={styles.previewSummary}
              aria-label="Retention preview summary"
            >
              <div>
                <span className={styles.eyebrow}>ELIGIBILITY CUTOFF</span>
                <strong>{new Date(preview.cutoff).toLocaleString()}</strong>
              </div>
              <div>
                <span className={styles.eyebrow}>CANDIDATES</span>
                <strong>
                  {preview.sources.length}
                  {preview.truncated ? "+" : ""}
                </strong>
              </div>
              {preview.truncated && (
                <p className={styles.truncationNote}>
                  This preview is limited. Additional sources may be eligible.
                </p>
              )}
            </section>
            {preview.sources.length ? (
              <div className={styles.retentionLayout}>
                <section
                  className={styles.retentionList}
                  aria-labelledby="candidates-heading"
                >
                  <div className={styles.panelHeading}>
                    <div>
                      <p className={styles.eyebrow}>ELIGIBLE EVIDENCE</p>
                      <h2 id="candidates-heading">Review candidates</h2>
                    </div>
                  </div>
                  <ul className={styles.candidateList}>
                    {preview.sources.map((s) => (
                      <li key={s.sourceId}>
                        <button
                          type="button"
                          className={`${styles.candidate} ${selected === s.sourceId ? styles.candidateSelected : ""}`}
                          aria-pressed={selected === s.sourceId}
                          onClick={() => chooseSource(s.sourceId)}
                        >
                          <span className={styles.candidateTitle}>
                            Source <span>{s.sourceId.slice(0, 12)}</span>
                          </span>
                          <span className={styles.candidateMeta}>
                            Latest revision {s.latestRevision}
                          </span>
                          <span className={styles.candidateStats}>
                            <span>
                              {s.expiredRevisions} expired{" "}
                              {s.expiredRevisions === 1
                                ? "revision"
                                : "revisions"}
                            </span>
                            <span>
                              {s.attachmentCount}{" "}
                              {s.attachmentCount === 1
                                ? "attachment"
                                : "attachments"}
                            </span>
                          </span>
                          <span className={styles.reviewAction}>
                            {selected === s.sourceId
                              ? "Selected for review"
                              : "Review redaction"}
                            {selected === s.sourceId ? null : (
                              <Icon name="arrowRight" size={16} />
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <section
                  className={`${styles.redactionReview} ${source ? styles.dangerZone : ""}`}
                  aria-labelledby="redaction-heading"
                >
                  {source ? (
                    <>
                      <div className={styles.panelHeading}>
                        <div>
                          <p className={styles.eyebrow}>
                            CONFIRM A PERMANENT ACTION
                          </p>
                          <h2 id="redaction-heading">Review redaction</h2>
                        </div>
                      </div>
                      <div className={styles.selectedSource}>
                        <span>Selected source</span>
                        <strong>{source.sourceId}</strong>
                        <span>
                          Revision {source.latestRevision} ·{" "}
                          {source.expiredRevisions} expired revisions ·{" "}
                          {source.attachmentCount} attachments
                        </span>
                      </div>
                      <p className={styles.reviewExplanation}>
                        This action redacts the source’s raw content and derived
                        data, then queues private file erasure. The numeric
                        contribution ledger remains available. This cannot be
                        undone.
                      </p>
                      <form onSubmit={redact} className={styles.redactionForm}>
                        <label htmlFor="redaction-reason">
                          Why should this evidence be redacted?
                        </label>
                        <span
                          id="redaction-reason-help"
                          className={styles.help}
                        >
                          This reason becomes part of the retention record. Do
                          not include more personal information than needed.
                        </span>
                        <TextArea
                          id="redaction-reason"
                          aria-describedby="redaction-reason-help"
                          required
                          maxLength={2000}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          rows={4}
                        />
                        <label className={styles.acknowledgment}>
                          <input
                            type="checkbox"
                            checked={ack}
                            onChange={(e) => setAck(e.target.checked)}
                          />
                          <span>
                            <strong>
                              I understand this action is permanent.
                            </strong>
                            <small>
                              The source and derived data will be redacted, and
                              private file erasure will be queued.
                            </small>
                          </span>
                        </label>
                        <div className={styles.confirmFooter}>
                          <Button
                            type="submit"
                            variant="danger"
                            disabled={pending || !ack || !reason.trim()}
                          >
                            {pending
                              ? "Recording redaction…"
                              : "Confirm permanent redaction"}
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={pending}
                            onClick={() => {
                              setSelected(null);
                              setReason("");
                              setAck(false);
                            }}
                          >
                            Cancel review
                          </Button>
                        </div>
                      </form>
                    </>
                  ) : (
                    <div className={styles.reviewPlaceholder}>
                      <span className={styles.reviewIcon} aria-hidden="true">
                        <Icon name="arrowLeft" size={24} />
                      </span>
                      <h2 id="redaction-heading">Select a candidate</h2>
                      <p>
                        Choose a source from the list to review its revision,
                        attachments and redaction requirements.
                      </p>
                    </div>
                  )}
                </section>
              </div>
            ) : (
              <section className={styles.card}>
                <div className={styles.empty}>
                  <h2>No sources need review</h2>
                  <p>
                    There is no expired evidence eligible for redaction right
                    now.
                  </p>
                </div>
              </section>
            )}
          </>
        )
      )}
    </div>
  );
}
