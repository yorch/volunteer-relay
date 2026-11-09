"use client";

import type { SourceEnvelope } from "@relay/contracts";
import { useEffect, useRef, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card, Live } from "../card";
import styles from "./shared.module.css";

export const key = () => crypto.randomUUID();
export const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not set";
export const duration = (minutes: number | null) => {
  if (minutes === null) return "Unknown";
  const rounded = Math.round(minutes);
  return rounded < 60
    ? `${rounded} min`
    : `${Math.floor(rounded / 60)} hr ${rounded % 60} min`;
};
export type Mutate = (
  endpoint: string,
  body: object,
  success: string,
  onSuccess?: (value: unknown) => void,
) => Promise<boolean>;
export function PendingSource({
  sourceId,
  status,
  close,
}: {
  sourceId: string;
  status: string;
  close: () => void;
}) {
  const [source, setSource] = useState<SourceEnvelope | null>(null);
  const [error, setError] = useState("");
  const evidenceHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    evidenceHeading.current?.focus();
  }, []);
  useEffect(() => {
    let active = true;
    void request<SourceEnvelope>(
      `/api/product/source?sourceId=${encodeURIComponent(sourceId)}`,
    ).then((result) => {
      if (!active) return;
      if (result.ok) setSource(result.value);
      else setError(errorMessage(result.error.code));
    });
    return () => {
      active = false;
    };
  }, [sourceId]);
  return (
    <Card className={styles.card}>
      <h2
        className={styles.evidenceHeading}
        ref={evidenceHeading}
        tabIndex={-1}
      >
        Original source evidence
      </h2>
      <p className={styles.meta}>
        Source {sourceId} · {status}
      </p>
      <button type="button" onClick={close}>
        Close evidence
      </button>
      <Live kind="alert">{error}</Live>
      {error ? null : source ? (
        <>
          <p className={styles.meta}>
            Source revision {source.revision} · {source.channel} · received{" "}
            {date(source.receivedAt)}
          </p>
          <p className={styles.source}>{source.text || "No text provided."}</p>
          {source.attachments.length > 0 && (
            <section>
              <h3>Source attachments</h3>
              {source.attachments.map((attachment) => (
                <figure key={attachment.id}>
                  {/* biome-ignore lint/performance/noImgElement: original private evidence uses the authenticated same-origin endpoint */}
                  <img
                    className={styles.attachment}
                    src={`/api/product/attachments/${encodeURIComponent(source.sourceId)}/${encodeURIComponent(attachment.id)}`}
                    alt={`Source attachment ${attachment.id}, revision ${source.revision}`}
                  />
                  <figcaption>
                    Source revision {source.revision} · attachment{" "}
                    {attachment.id}
                  </figcaption>
                </figure>
              ))}
            </section>
          )}
          <p>
            {status === "your update"
              ? "This is your original update, shown read-only."
              : "Read-only evidence. Review actions are available when a proposal is ready."}
          </p>
        </>
      ) : null}
      <Live kind="polite">
        {!error && !source ? "Loading source evidence…" : ""}
      </Live>
    </Card>
  );
}
