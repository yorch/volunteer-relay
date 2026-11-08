"use client";
import type {
  DeliveryStatus,
  OperationalStatus,
  ProductAuditEntry,
} from "@relay/contracts";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card as BaseCard, Live } from "../card";
import styles from "./admin.module.css";

const load = <T,>(url: string) => request<T>(url);
const message = errorMessage;
function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <BaseCard className={`${styles.card} ${className}`}>{children}</BaseCard>
  );
}
function stamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}
function json(value: unknown) {
  return value === null || value === undefined
    ? "None"
    : JSON.stringify(value, null, 2);
}
function describeAction(action: string) {
  const labels: Record<string, string> = {
    created: "Record created",
    updated: "Record updated",
    assigned: "Work assigned",
    acknowledged: "Need acknowledged",
    resolved: "Need resolved",
    redacted: "Source redacted",
    role_changed: "Workspace access changed",
    invited: "Member invited",
    removed: "Member removed",
  };
  return (
    labels[action] ??
    action.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}
function Actor({ actor }: { actor: unknown }) {
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const obj = actor as Record<string, unknown>;
    const label =
      obj.kind === "user"
        ? "Team member"
        : obj.kind === "system"
          ? "Relay system"
          : "Recorded actor";
    const identifier =
      typeof obj.membershipId === "string" ? obj.membershipId : null;
    return (
      <span>
        {label}
        {identifier ? (
          <span className={styles.actorId}> · {identifier.slice(0, 8)}</span>
        ) : (
          ""
        )}
      </span>
    );
  }
  return <span>Recorded actor</span>;
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
    if (before) {
      const parsed = new Date(before);
      if (Number.isNaN(parsed.getTime())) {
        setError("Enter a valid date and time.");
        return;
      }
      query.set("before", parsed.toISOString());
    }
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
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>ACCOUNTABILITY</p>
          <h1>History</h1>
          <p>
            Follow the changes made to a record, including who acted and why.
          </p>
        </div>
      </header>
      <Card className={styles.searchCard}>
        <form className={styles.historySearch} onSubmit={search}>
          <label>
            Record ID
            <input
              name="aggregateId"
              required
              placeholder="Paste a need, source or activity ID"
            />
          </label>
          <label>
            Before <span className={styles.optional}>(optional)</span>
            <input name="before" type="datetime-local" />
          </label>
          <button type="submit" disabled={pending}>
            {pending ? "Loading history…" : "Find history"}
          </button>
        </form>
        <p className={styles.help}>
          Showing up to 100 changes, newest first. Add a date to look further
          back.
        </p>
      </Card>
      <Live kind="polite" className={styles.loading}>
        {pending ? "Loading the record timeline…" : ""}
      </Live>
      <Live kind="alert" className={styles.error}>
        {error}
      </Live>
      {entries?.length ? (
        <section className={styles.timeline} aria-label="Record history">
          <div className={styles.timelineHeading}>
            <h2>Change timeline</h2>
            <span>
              {entries.length} {entries.length === 1 ? "change" : "changes"}
            </span>
          </div>
          {entries.map((entry) => (
            <article
              className={styles.timelineEntry}
              key={`${entry.aggregateType}:${entry.aggregateId}:${entry.revision}:${entry.occurredAt}`}
            >
              <span className={styles.timelineDot} aria-hidden="true" />
              <Card className={styles.auditCard}>
                <div className={styles.auditTopline}>
                  <span className={styles.eventBadge}>
                    {entry.aggregateType.replace(/[-_]+/g, " ")}
                  </span>
                  <time dateTime={entry.occurredAt}>
                    {stamp(entry.occurredAt)}
                  </time>
                </div>
                <h3>{describeAction(entry.action)}</h3>
                <dl className={styles.auditSummary}>
                  <div>
                    <dt>By</dt>
                    <dd>
                      <Actor actor={entry.actor} />
                    </dd>
                  </div>
                  <div>
                    <dt>Record</dt>
                    <dd>
                      {entry.aggregateType} · revision {entry.revision}
                    </dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{entry.reason ?? "No reason was recorded."}</dd>
                  </div>
                </dl>
                <details className={styles.technicalDetails}>
                  <summary>Technical record details</summary>
                  <p className={styles.technicalNote}>
                    Record identifiers and before/after data for audit review.
                  </p>
                  <dl className={styles.auditSummary}>
                    <div>
                      <dt>Record ID</dt>
                      <dd>{entry.aggregateId}</dd>
                    </div>
                  </dl>
                  <div className={styles.jsonGrid}>
                    <section>
                      <h4>Before</h4>
                      <pre className={styles.auditJson}>
                        {json(entry.before)}
                      </pre>
                    </section>
                    <section>
                      <h4>After</h4>
                      <pre className={styles.auditJson}>
                        {json(entry.after)}
                      </pre>
                    </section>
                    <section>
                      <h4>Actor record</h4>
                      <pre className={styles.auditJson}>
                        {json(entry.actor)}
                      </pre>
                    </section>
                  </div>
                </details>
              </Card>
            </article>
          ))}
        </section>
      ) : !pending && searched && !error ? (
        <Card className={styles.empty}>
          <h2>No changes found</h2>
          <p>
            Check the record ID or choose a later “Before” date and try again.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
function formatMoney(microUsd: number) {
  return `$${(microUsd / 1_000_000).toFixed(6)}`;
}
function formatStorage(bytes: number | null) {
  if (bytes === null) return "Unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`${styles.statusBadge} ${styles[`status_${status.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`] ?? ""}`}
    >
      {status.replace(/[-_]+/g, " ")}
    </span>
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
  const failed = deliveries?.filter((d) => d.status === "failed").length ?? 0;
  const accepted = deliveries?.filter((d) => d.acceptedAt !== null).length ?? 0;
  return (
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>SERVICE HEALTH</p>
          <h1>Delivery and operations</h1>
          <p>See where updates and notifications stand across the workspace.</p>
        </div>
      </header>
      <aside className={styles.definitionNote}>
        <strong>Delivery status has limits.</strong> Provider acceptance means a
        delivery request was accepted for processing. It does not confirm that a
        person received or acknowledged the need.
      </aside>
      {owner && (
        <section className={styles.opsSection} aria-labelledby="ops-heading">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>OWNER VIEW</p>
              <h2 id="ops-heading">Organization operations</h2>
            </div>
          </div>
          <Live kind="polite" className={styles.loading}>
            {opsLoading ? "Loading operations…" : ""}
          </Live>
          <Live kind="alert" className={styles.error}>
            {opsLoading ? "" : opsError}
          </Live>
          {opsLoading || opsError ? null : operations ? (
            <div className={styles.opsGrid}>
              <Card className={styles.metricCard}>
                <span className={styles.metricLabel}>Source queue</span>
                <strong className={styles.metricValue}>
                  {operations.queuedSources}
                </strong>
                <span className={styles.metricCaption}>
                  {operations.failedSources} failed · oldest queued{" "}
                  {stamp(operations.oldestQueuedAt)}
                </span>
              </Card>
              <Card className={styles.metricCard}>
                <span className={styles.metricLabel}>Urgent needs</span>
                <strong className={styles.metricValue}>
                  {operations.unresolvedUrgentNeeds}
                </strong>
                <span className={styles.metricCaption}>
                  {operations.overdueAcknowledgments} acknowledgments overdue
                </span>
              </Card>
              <Card className={styles.metricCard}>
                <span className={styles.metricLabel}>Failed deliveries</span>
                <strong
                  className={`${styles.metricValue} ${operations.failedDeliveries ? styles.metricWarn : ""}`}
                >
                  {operations.failedDeliveries}
                </strong>
                <span className={styles.metricCaption}>
                  Requests that need attention
                </span>
              </Card>
              <Card className={styles.metricCard}>
                <span className={styles.metricLabel}>Model usage</span>
                <strong className={styles.metricValue}>
                  {formatMoney(operations.modelSettledMicroUsd)}
                </strong>
                <span className={styles.metricCaption}>
                  Settled · {formatMoney(operations.modelReservedMicroUsd)}{" "}
                  reserved
                </span>
              </Card>
              <Card className={styles.metricCard}>
                <span className={styles.metricLabel}>Available storage</span>
                <strong className={styles.metricValue}>
                  {formatStorage(operations.availableStorageBytes)}
                </strong>
                <span className={styles.metricCaption}>
                  Current service estimate
                </span>
              </Card>
            </div>
          ) : null}
        </section>
      )}
      <section
        className={styles.deliverySection}
        aria-labelledby="delivery-heading"
      >
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.eyebrow}>NOTIFICATION ACTIVITY</p>
            <h2 id="delivery-heading">Deliveries</h2>
          </div>
          {deliveries && (
            <span className={styles.count}>{deliveries.length} total</span>
          )}
        </div>
        {!pending && !error && deliveries?.length ? (
          <div className={styles.deliverySummary}>
            <span>
              <strong>{accepted}</strong> provider accepted
            </span>
            <span>
              <strong className={failed ? styles.metricWarn : ""}>
                {failed}
              </strong>{" "}
              failed
            </span>
            <span>
              {deliveries.length - accepted - failed} pending or other
            </span>
          </div>
        ) : null}
        <Live kind="polite" className={styles.loading}>
          {pending ? "Loading deliveries…" : ""}
        </Live>
        <Live kind="alert" className={styles.error}>
          {pending ? "" : error}
        </Live>
        {pending || error ? null : deliveries?.length ? (
          <div className={styles.tableWrap}>
            <table className={styles.deliveryTable} aria-label="Deliveries">
              <thead>
                <tr>
                  <th scope="col">Channel</th>
                  <th scope="col">Status</th>
                  <th scope="col">Attempts</th>
                  <th scope="col">Provider accepted</th>
                  <th scope="col">Person acknowledgment</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td data-label="Channel">
                      <strong>{d.channel}</strong>
                      <span className={styles.tableSub}>
                        {d.template.replace(/[-_]+/g, " ")}
                      </span>
                    </td>
                    <td data-label="Status">
                      <StatusBadge status={d.status} />
                    </td>
                    <td data-label="Attempts">{d.attempts}</td>
                    <td data-label="Provider accepted">
                      {d.acceptedAt ? stamp(d.acceptedAt) : "Not accepted"}
                    </td>
                    <td data-label="Person acknowledgment">
                      <span className={styles.notProvided}>
                        Confirm with the need record
                      </span>
                    </td>
                    <td data-label="Details">
                      <details className={styles.technicalDetails}>
                        <summary>View</summary>
                        <dl className={styles.detailList}>
                          <div>
                            <dt>Need</dt>
                            <dd>{d.needId}</dd>
                          </div>
                          <div>
                            <dt>Recipient</dt>
                            <dd>{d.recipientId}</dd>
                          </div>
                          <div>
                            <dt>Retry after</dt>
                            <dd>{stamp(d.retryAfter)}</dd>
                          </div>
                          <div>
                            <dt>Provider accepted</dt>
                            <dd>{stamp(d.acceptedAt)}</dd>
                          </div>
                        </dl>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Card className={styles.empty}>
            <h3>No deliveries yet</h3>
            <p>
              Notification attempts will appear here when the workspace sends an
              update.
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
