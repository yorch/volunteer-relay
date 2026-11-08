"use client";
import type {
  DeliveryStatus,
  OperationalStatus,
  ProductAuditEntry,
} from "@relay/contracts";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import styles from "./product.module.css";

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string } };
async function load<T>(url: string): Promise<Result<T>> {
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const result = (await response.json()) as Result<T>;
    if (result && typeof result.ok === "boolean") return result;
  } catch {}
  return { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } };
}
function message(code: string) {
  return code === "FORBIDDEN"
    ? "You do not have permission to view this information."
    : code === "UNAUTHENTICATED"
      ? "Please sign in."
      : "Unable to load this information. Please try again.";
}
function Card({ children }: { children: ReactNode }) {
  return <section className={styles.card}>{children}</section>;
}
function stamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}
function json(value: unknown) {
  return value === null || value === undefined
    ? "None"
    : JSON.stringify(value, null, 2);
}
function Actor({ actor }: { actor: unknown }) {
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const obj = actor as Record<string, unknown>;
    return (
      <>
        <strong>
          {obj.kind === "user"
            ? "Person"
            : obj.kind === "system"
              ? "System"
              : "Actor"}
        </strong>
        <pre className={styles.auditJson}>{json(actor)}</pre>
      </>
    );
  }
  return (
    <>
      <strong>Actor</strong>
      <pre className={styles.auditJson}>{json(actor)}</pre>
    </>
  );
}
export function History() {
  const [entries, setEntries] = useState<ProductAuditEntry[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  async function search(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const id = String(f.get("aggregateId") || "").trim();
    if (!id) return;
    const query = new URLSearchParams({ aggregateId: id });
    const before = String(f.get("before") || "");
    if (before) query.set("before", new Date(before).toISOString());
    setPending(true);
    setError("");
    setEntries(null);
    setSearched(true);
    const result = await load<{ entries: ProductAuditEntry[] }>(
      `/api/product/audit?${query}`,
    );
    if (result.ok) setEntries(result.value.entries);
    else setError(message(result.error.code));
    setPending(false);
  }
  return (
    <>
      <h1>History</h1>
      <p>
        Find the latest 100 changes for a record, newest first. Use “Before” to
        look at earlier changes.
      </p>
      <Card>
        <form onSubmit={search}>
          <label>
            Record ID
            <input name="aggregateId" required />
          </label>
          <label>
            Before (optional)
            <input name="before" type="datetime-local" />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Loading…" : "Find history"}
          </button>
        </form>
      </Card>
      {error && <p role="alert">{error}</p>}
      {entries?.length ? (
        entries.map((entry) => (
          <Card key={JSON.stringify(entry)}>
            <h2>{entry.action}</h2>
            <p>
              {entry.aggregateType} · {entry.aggregateId} · revision{" "}
              {entry.revision} · {stamp(entry.occurredAt)}
            </p>
            <Actor actor={entry.actor} />
            <p>Reason: {entry.reason ?? "Not provided"}</p>
            <details>
              <summary>Before and after</summary>
              <h3>Before</h3>
              <pre className={styles.auditJson}>{json(entry.before)}</pre>
              <h3>After</h3>
              <pre className={styles.auditJson}>{json(entry.after)}</pre>
            </details>
          </Card>
        ))
      ) : !pending && searched && !error ? (
        <p>No history found for this record.</p>
      ) : null}
    </>
  );
}
export function Delivery({ owner }: { owner: boolean }) {
  const [deliveries, setDeliveries] = useState<DeliveryStatus[] | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const [operations, setOperations] = useState<OperationalStatus | null>(null);
  const [opsError, setOpsError] = useState("");
  const [opsLoading, setOpsLoading] = useState(owner);
  useEffect(() => {
    let active = true;
    void load<DeliveryStatus[]>("/api/product/deliveries").then((result) => {
      if (!active) return;
      if (result.ok) setDeliveries(result.value);
      else setError(message(result.error.code));
      setPending(false);
    });
    if (owner)
      void load<OperationalStatus>("/api/product/operations").then((result) => {
        if (!active) return;
        if (result.ok) setOperations(result.value);
        else setOpsError(message(result.error.code));
        setOpsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [owner]);
  return (
    <>
      <h1>Delivery and operations</h1>
      <p>
        Provider acceptance means the provider accepted a delivery request. It
        does not mean a person acknowledged the need.
      </p>
      <h2>Deliveries</h2>
      {pending ? (
        <p aria-live="polite">Loading deliveries…</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : deliveries?.length ? (
        deliveries.map((d) => (
          <Card key={d.id}>
            <h3>
              {d.channel} · {d.status}
            </h3>
            <p>
              Need {d.needId} · recipient {d.recipientId} · template{" "}
              {d.template}
            </p>
            <p>
              Attempts: {d.attempts} · Provider accepted: {stamp(d.acceptedAt)}{" "}
              · Retry after: {stamp(d.retryAfter)}
            </p>
          </Card>
        ))
      ) : (
        <p>No deliveries found.</p>
      )}
      {owner && (
        <>
          <h2>Organization operations</h2>
          {opsLoading ? (
            <p aria-live="polite">Loading operations…</p>
          ) : opsError ? (
            <p role="alert">{opsError}</p>
          ) : (
            operations && (
              <div className={styles.metrics}>
                <Card>
                  <h3>Source queue</h3>
                  <p>
                    {operations.queuedSources} queued ·{" "}
                    {operations.failedSources} failed
                  </p>
                  <p>Oldest queued: {stamp(operations.oldestQueuedAt)}</p>
                </Card>
                <Card>
                  <h3>Needs</h3>
                  <p>
                    {operations.unresolvedUrgentNeeds} unresolved urgent ·{" "}
                    {operations.overdueAcknowledgments} overdue acknowledgments
                  </p>
                </Card>
                <Card>
                  <h3>Failed deliveries</h3>
                  <p>{operations.failedDeliveries}</p>
                </Card>
                <Card>
                  <h3>Model costs</h3>
                  <p>
                    Reserved:{" "}
                    {(operations.modelReservedMicroUsd / 1_000_000).toFixed(6)}{" "}
                    USD · settled:{" "}
                    {(operations.modelSettledMicroUsd / 1_000_000).toFixed(6)}{" "}
                    USD
                  </p>
                </Card>
                <Card>
                  <h3>Available storage</h3>
                  <p>
                    {operations.availableStorageBytes === null
                      ? "Unknown"
                      : `${operations.availableStorageBytes} bytes`}
                  </p>
                </Card>
              </div>
            )
          )}
        </>
      )}
    </>
  );
}
