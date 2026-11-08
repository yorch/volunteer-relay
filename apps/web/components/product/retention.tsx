"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import styles from "./product.module.css";

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
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string } };
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
    try {
      const response = await fetch("/api/product/retention-preview", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const result = (await response.json()) as Result<Preview>;
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
    } catch {
      setPreview(null);
      setError("Unable to load retention preview.");
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
  return (
    <>
      <h1>Retention</h1>
      <p>
        Review expired source evidence before redaction. Redaction is
        irreversible; numeric ledger records are kept.
      </p>
      <p>
        <a href="/api/product/retention-ledger">
          Download signed retention ledger
        </a>
      </p>
      {loading ? (
        <p aria-live="polite">Loading retention preview…</p>
      ) : error ? (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => void refresh()}>
            Try again
          </button>
        </>
      ) : (
        preview && (
          <>
            <p>
              Retention cutoff: {new Date(preview.cutoff).toLocaleString()}
              {preview.truncated &&
                " · Preview truncated; additional sources may be eligible."}
            </p>
            {preview.sources.length ? (
              preview.sources.map((s) => (
                <section className={styles.card} key={s.sourceId}>
                  <h2>Source {s.sourceId}</h2>
                  <p>
                    Latest revision {s.latestRevision} · expired revisions{" "}
                    {s.expiredRevisions} · {s.attachmentCount} attachments
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(s.sourceId);
                      setReason("");
                      setAck(false);
                    }}
                  >
                    Review redaction
                  </button>
                </section>
              ))
            ) : (
              <p>No sources currently eligible for redaction.</p>
            )}
            {source && (
              <section className={styles.card}>
                <h2>Redact source {source.sourceId}</h2>
                <p>
                  This irreversibly redacts raw source and derived data and
                  queues private file erasure. Numeric ledger records are kept.
                </p>
                <form onSubmit={redact}>
                  <label>
                    Reason for redaction
                    <textarea
                      required
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <label style={{ display: "flex", alignItems: "center" }}>
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />{" "}
                    I understand this redaction is irreversible.
                  </label>
                  <button
                    type="submit"
                    disabled={pending || !ack || !reason.trim()}
                  >
                    Confirm redaction
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setSelected(null);
                      setReason("");
                      setAck(false);
                    }}
                  >
                    Cancel
                  </button>
                </form>
              </section>
            )}
          </>
        )
      )}
    </>
  );
}
