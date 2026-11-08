"use client";

import {
  type ContributionRecord,
  type NeedRecord,
  type ProductReport,
  productEndpoints,
  type Receipt,
  type ReviewQueueEntry,
  reportQuerySchema,
  type SourceEnvelope,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { loadOrganizations, mutateAuth } from "../auth/transport";
import { StaffShell, VolunteerShell } from "../layout";
import { Members, Notifications, Settings } from "./admin";
import { Delivery, History } from "./operations";
import styles from "./product.module.css";

type Page =
  | "volunteer"
  | "inbox"
  | "activities"
  | "needs"
  | "reports"
  | "import"
  | "settings"
  | "members"
  | "notifications"
  | "history"
  | "delivery";
type ResponseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string } };
const key = () => crypto.randomUUID();
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not set";
const instant = (value: FormDataEntryValue | null) =>
  value ? new Date(String(value)).toISOString() : null;
async function request<T>(
  path: string,
  body?: object,
): Promise<ResponseResult<T>> {
  try {
    const response = await fetch(path, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json()) as ResponseResult<T>;
    if (
      data &&
      typeof data === "object" &&
      (data.ok === true || data.ok === false)
    )
      return data;
  } catch {
    /* network or invalid response */
  }
  return { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } };
}
function errorMessage(code: string) {
  if (code === "UNAUTHENTICATED")
    return "Please sign in to access your workspace.";
  if (code === "FORBIDDEN")
    return "You do not have permission to access this workspace.";
  if (code === "CONFLICT")
    return "This record changed. Refresh the workspace and try again.";
  if (code === "VALIDATION") return "Please check the fields and try again.";
  return "The service is unavailable. Please try again.";
}
function Organization() {
  const [choices, setChoices] = useState<Awaited<
    ReturnType<typeof loadOrganizations>
  > | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void loadOrganizations().then(setChoices);
  }, []);
  if (!choices?.ok || choices.value.options.length < 2)
    return <a href="/account">Account</a>;
  return (
    <div>
      <label htmlFor="organization">Organization</label>
      <select
        id="organization"
        value={choices.value.currentOrganizationId ?? ""}
        onChange={async (e) => {
          const result = await mutateAuth("organizations/select", {
            organizationId: e.target.value,
          });
          if (result.ok) window.location.href = "/workspace";
          else setError(errorMessage(result.error.code));
        }}
      >
        {choices.value.options.map((option) => (
          <option key={option.organizationId} value={option.organizationId}>
            {option.name}
          </option>
        ))}
      </select>
      {error && <p role="alert">{error}</p>}
      <a href="/account">Account</a>
    </div>
  );
}
export function ProductWorkspace({ page }: { page: Page | "home" }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>(
    {},
  );
  const refresh = useCallback(async () => {
    const result = await request<WorkspaceSnapshot>(productEndpoints.workspace);
    if (result.ok) {
      setSnapshot(result.value);
      setError("");
    } else {
      setSnapshot(null);
      setError(errorMessage(result.error.code));
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const mutate = async (
    endpoint: string,
    body: object,
    success: string,
    onSuccess?: (value: unknown) => void,
  ) => {
    setError("");
    setNotice("");
    const { idempotencyKey: _ignored, ...draft } = body as Record<
      string,
      unknown
    >;
    const signature = JSON.stringify(draft);
    let attempt = attempts.current[endpoint];
    if (!attempt || attempt.signature !== signature) {
      attempt = { signature, key: key() };
      attempts.current[endpoint] = attempt;
    }
    const result = await request<unknown>(endpoint, {
      ...draft,
      idempotencyKey: attempt.key,
    });
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return false;
    }
    if (attempts.current[endpoint] === attempt)
      delete attempts.current[endpoint];
    onSuccess?.(result.value);
    setNotice(success);
    await refresh();
    return true;
  };
  if (loading)
    return (
      <main className={styles.standalone} aria-live="polite">
        Loading workspace…
      </main>
    );
  if (!snapshot)
    return (
      <main className={styles.standalone}>
        <h1>Workspace unavailable</h1>
        <p role="alert">{error}</p>
        <a href="/sign-in">Sign in</a>{" "}
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void refresh();
          }}
        >
          Try again
        </button>
      </main>
    );
  const role = snapshot.organization.role;
  const staff = role === "owner" || role === "coordinator";
  const activePage: Page =
    page === "home"
      ? staff
        ? "inbox"
        : role === "volunteer"
          ? "volunteer"
          : "reports"
      : page;
  const allowed =
    activePage === "notifications"
      ? true
      : activePage === "members"
        ? role === "owner"
        : activePage === "volunteer"
          ? role === "volunteer"
          : activePage === "reports"
            ? role === "report-reader" || staff
            : staff;
  const nav = staff
    ? [
        { href: "/workspace/inbox", label: "Source inbox" },
        { href: "/workspace/activities", label: "Activities" },
        { href: "/workspace/needs", label: "Needs" },
        { href: "/workspace/import", label: "Import" },
        { href: "/workspace/reports", label: "Summary" },
        { href: "/workspace/settings", label: "Settings" },
        { href: "/workspace/history", label: "History" },
        { href: "/workspace/delivery", label: "Delivery" },
        ...(role === "owner"
          ? [{ href: "/workspace/members", label: "Members" }]
          : []),
        { href: "/workspace/notifications", label: "Notifications" },
      ]
    : [
        { href: "/workspace/reports", label: "Summary" },
        { href: "/workspace/notifications", label: "Notifications" },
      ];
  const content = (
    <div
      onChangeCapture={() => {
        attempts.current = {};
      }}
    >
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {!allowed ? (
        <>
          <h1>Permission denied</h1>
          <p>Your role does not have access to this page.</p>
          <a href="/workspace">Go to your workspace</a>
        </>
      ) : activePage === "volunteer" ? (
        <Volunteer snapshot={snapshot} mutate={mutate} refresh={refresh} />
      ) : activePage === "inbox" ? (
        <Inbox snapshot={snapshot} mutate={mutate} refresh={refresh} />
      ) : activePage === "activities" ? (
        <Activities snapshot={snapshot} mutate={mutate} />
      ) : activePage === "needs" ? (
        <Needs snapshot={snapshot} mutate={mutate} />
      ) : activePage === "history" ? (
        <History />
      ) : activePage === "delivery" ? (
        <Delivery owner={role === "owner"} />
      ) : activePage === "settings" ? (
        <Settings snapshot={snapshot} />
      ) : activePage === "members" ? (
        <Members />
      ) : activePage === "notifications" ? (
        <Notifications />
      ) : activePage === "import" ? (
        <Import members={snapshot.members} />
      ) : (
        <Summary snapshot={snapshot} />
      )}
    </div>
  );
  return role === "volunteer" ? (
    <VolunteerShell
      organization={snapshot.organization.name}
      mainId="workspace-main"
      account={
        <>
          <a href="/workspace/volunteer">My updates</a>
          {" · "}
          <a href="/workspace/notifications">Notifications</a>
          {" · "}
          <Organization />
        </>
      }
    >
      {content}
    </VolunteerShell>
  ) : (
    <StaffShell
      organization={snapshot.organization.name}
      mainId="workspace-main"
      currentPath={`/workspace/${activePage}`}
      navigation={nav}
      account={<Organization />}
    >
      {content}
    </StaffShell>
  );
}
type Mutate = (
  endpoint: string,
  body: object,
  success: string,
  onSuccess?: (value: unknown) => void,
) => Promise<boolean>;
function Card({ children }: { children: ReactNode }) {
  return <section className={styles.card}>{children}</section>;
}
function Volunteer({
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
      try {
        const response = await fetch("/api/product/source-photo", {
          method: "POST",
          credentials: "same-origin",
          body: form,
        });
        const result = (await response.json()) as ResponseResult<Receipt>;
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
      } catch {
        setPhotoError("The service is unavailable. Please try again.");
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
    <>
      <h1>How did you help today?</h1>
      <p>Share an update with your team.</p>
      <Card>
        <form onSubmit={submit}>
          <label htmlFor="update">Your update</label>
          <textarea
            id="update"
            required
            maxLength={20000}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              photoKey.current = null;
            }}
            rows={6}
          />
          <label htmlFor="photo">
            Photo (optional; PNG, JPEG or WebP, up to 10 MB)
          </label>
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
          {photoError && <p role="alert">{photoError}</p>}
          <button disabled={pending} type="submit">
            {pending ? "Sending…" : "Send update"}
          </button>
        </form>
        {receipt && <p role="status">{receipt}</p>}
      </Card>
      <h2>Your updates</h2>
      {snapshot.sources.length ? (
        <ul>
          {snapshot.sources.map((s) => (
            <li key={s.sourceId}>
              Update {s.sourceId} · revision {s.revision} · {s.status}
            </li>
          ))}
        </ul>
      ) : (
        <p>No updates yet.</p>
      )}
      <h2>Your contributions</h2>
      <ContributionList
        contributions={snapshot.contributions}
        members={snapshot.members}
      />
    </>
  );
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
    <p>No contributions yet.</p>
  );
}
function Inbox({
  snapshot,
  mutate,
  refresh,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
  refresh: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const failed = snapshot.sources.filter(
    (source) => source.status === "failed",
  );
  const entry = snapshot.queue.find((e) => e.proposal.runId === selected);
  return (
    <>
      <h1>Source inbox</h1>
      <p>Review the original update alongside its proposed fields.</p>
      <Card>
        <h2>Processing failures</h2>
        {failed.length ? (
          <>
            <p>
              Retry processing these updates. The original evidence is retained.
            </p>
            <ul className={styles.list}>
              {failed.map((source) => (
                <li key={source.sourceId}>
                  Source {source.sourceId} · revision {source.revision}{" "}
                  <button
                    type="button"
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
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>No processing failures.</p>
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
                <li key={source.sourceId}>
                  Source {source.sourceId} · revision {source.revision} ·{" "}
                  {source.status}{" "}
                  <button
                    type="button"
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
                </li>
              ))}
          </ul>
        ) : (
          <p>No updates available to reprocess.</p>
        )}
      </Card>
      {snapshot.queue.length === 0 ? (
        <p>No sources awaiting review.</p>
      ) : (
        <div className={styles.columns}>
          <Card>
            <h2>Awaiting review</h2>
            <button type="button" onClick={() => void refresh()}>
              Refresh inbox
            </button>
            <ul className={styles.list}>
              {snapshot.queue.map((item) => (
                <li key={item.proposal.runId}>
                  <button
                    type="button"
                    aria-pressed={entry?.proposal.runId === item.proposal.runId}
                    onClick={() => setSelected(item.proposal.runId)}
                  >
                    Source {item.source.sourceId} · revision{" "}
                    {item.source.revision}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {entry ? (
            <ReviewEditor
              key={`${entry.proposal.runId}-${entry.revision}`}
              entry={entry}
              members={snapshot.members}
              mutate={mutate}
              clear={() => setSelected(null)}
            />
          ) : (
            <Card>
              <p>Select a source to review.</p>
            </Card>
          )}
        </div>
      )}
    </>
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
  return (
    <Card>
      <h2>Original update</h2>
      <p className={styles.source}>
        {entry.source.text || "No text provided."}
      </p>
      <p>
        Channel: {entry.source.channel} · received{" "}
        {date(entry.source.receivedAt)} · source revision{" "}
        {entry.source.revision}
      </p>
      {entry.source.attachments?.length > 0 && (
        <section>
          <h3>Source attachments</h3>
          <p>
            Original evidence attached to source revision{" "}
            {entry.source.revision}.
          </p>
          {entry.source.attachments.map((attachment) => (
            <figure key={attachment.id}>
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
      <h3>Proposed fields</h3>
      {items.length ? (
        items.map((item, index) => (
          <div className={styles.item} key={item.key}>
            <strong>{item.kind}</strong>
            <dl>
              {Object.entries(item)
                .filter(([name]) => !["kind", "key", "evidence"].includes(name))
                .map(([name, value]) => (
                  <div key={name}>
                    <dt>{name}</dt>
                    <dd>{value === null ? "Unknown" : String(value)}</dd>
                  </div>
                ))}
            </dl>
            {item.kind === "contribution" && (
              <>
                <label>
                  Volunteer for {item.key}
                  <select
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
                  </select>
                </label>
                <label>
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
              </>
            )}
            {item.kind === "activity" && (
              <div>
                <p>
                  Possible existing activities are suggestions; choose one only
                  after confirming it is the same activity.
                </p>
                {candidateError ? (
                  <p role="alert">{candidateError}</p>
                ) : candidates === null ? (
                  <p>Loading possible matches…</p>
                ) : candidates.length === 0 ? (
                  <p>No possible matches.</p>
                ) : (
                  <label>
                    Link existing activity for {item.key}
                    <select
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
                    </select>
                  </label>
                )}
              </div>
            )}
            {item.kind === "activity" && (
              <label>
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
            )}
            {item.kind === "correction" && (
              <>
                <p>
                  This proposed correction identifies a target and revision.
                  Check the original evidence before accepting; explain any
                  staff changes in the review reason.
                </p>
                <label>
                  Target ID for {item.key}
                  <input
                    value={item.targetId ?? ""}
                    onChange={(e) =>
                      update(index, { targetId: e.target.value || null })
                    }
                  />
                </label>
                <label>
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
                <label>
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
              </>
            )}
            <p>Original evidence:</p>
            <ul>
              {item.evidence.map((e) => (
                <li key={JSON.stringify(e)}>
                  {e.field}:{" "}
                  {e.kind === "text" ? `“${e.quote}”` : e.observation} (source
                  revision {e.sourceRevision})
                </li>
              ))}
            </ul>
          </div>
        ))
      ) : (
        <p>No proposed fields.</p>
      )}
      {entry.proposal.unresolved.length > 0 && (
        <>
          <h3>Unresolved in original proposal</h3>
          <ul>
            {entry.proposal.unresolved.map((u) => (
              <li key={JSON.stringify(u)}>
                {u.field}: {u.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <label htmlFor="review-reason">
        Review reason {(changed || linked) && "(required for edits or links)"}
      </label>
      <textarea
        id="review-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <p>
        Incomplete contributions remain pending when accepted. Staff edits
        retain the original evidence and require a reason.
      </p>
      <div className={styles.actions}>
        <button
          disabled={pending || ((changed || linked) && !reason.trim())}
          type="button"
          onClick={() => void decide("accept")}
        >
          Accept proposal
        </button>
        <button
          disabled={pending || !reason.trim()}
          type="button"
          onClick={() => void decide("reject")}
        >
          Reject proposal
        </button>
      </div>
      <p>
        Rejecting a proposal does not automatically withdraw a provisional need.
      </p>
    </Card>
  );
}
function Activities({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const localDate = String(f.get("date") || "");
    const minutes = String(f.get("minutes") || "");
    if (
      await mutate(
        productEndpoints.activity,
        {
          schemaVersion: 1,
          idempotencyKey: key(),
          kind: String(f.get("kind")),
          localDate: localDate || null,
          datePrecision: localDate ? "day" : "unknown",
          beneficiaryReference: String(f.get("beneficiary") || "") || null,
          origin: { kind: "staff", reason: String(f.get("reason")) },
          contributions: [
            {
              membershipId: String(f.get("member") || "") || null,
              durationMinutes: minutes ? Number(minutes) : null,
            },
          ],
        },
        "Activity recorded.",
      )
    )
      form.reset();
  }
  return (
    <>
      <h1>Activities and contributions</h1>
      <p>
        Approved contributions form the reporting ledger. Unknown durations
        remain pending.
      </p>
      <Card>
        <h2>Record an activity</h2>
        <form onSubmit={create}>
          <label>
            Activity type
            <input name="kind" required maxLength={100} />
          </label>
          <label>
            Date (leave blank if unknown)
            <input name="date" type="date" />
          </label>
          <label>
            Beneficiary reference (optional)
            <input name="beneficiary" maxLength={200} />
          </label>
          <label>
            Volunteer
            <select name="member">
              <option value="">Unknown</option>
              {snapshot.members.map((m) => (
                <option key={m.membershipId} value={m.membershipId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Duration in minutes (leave blank if unknown)
            <input name="minutes" type="number" min="1" max="1440" />
          </label>
          <label>
            Reason for staff entry
            <input name="reason" required maxLength={2000} />
          </label>
          <button type="submit">Record activity</button>
        </form>
      </Card>
      <h2>Contribution ledger</h2>
      {snapshot.contributions.length ? (
        snapshot.contributions.map((c) => (
          <Contribution
            key={c.contributionId}
            contribution={c}
            members={snapshot.members}
            mutate={mutate}
          />
        ))
      ) : (
        <p>No contributions yet.</p>
      )}
    </>
  );
}
function Contribution({
  contribution: c,
  members,
  mutate,
}: {
  contribution: ContributionRecord;
  members: WorkspaceSnapshot["members"];
  mutate: Mutate;
}) {
  async function transition(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const action = String(f.get("action"));
    const base = {
      schemaVersion: 1,
      idempotencyKey: key(),
      contributionId: c.contributionId,
      expectedRevision: c.revision,
      action,
    };
    const body =
      action === "correct"
        ? {
            ...base,
            durationMinutes: Number(f.get("minutes")),
            reason: String(f.get("reason")),
          }
        : base;
    await mutate(productEndpoints.contribution, body, "Contribution updated.");
  }
  return (
    <Card>
      <p>
        <strong>
          {members.find((m) => m.membershipId === c.membershipId)?.name ??
            (c.membershipId ? "Volunteer" : "Unknown volunteer")}
        </strong>{" "}
        ·{" "}
        {c.durationMinutes === null
          ? "Unknown duration"
          : `${c.durationMinutes} minutes`}{" "}
        · {c.status} · revision {c.revision}
      </p>
      <p>Activity {c.activityId}</p>
      <p>
        {c.origin.kind === "source"
          ? `Source ${c.origin.sourceId} · revision ${c.origin.sourceRevision}`
          : `Staff entry reason: ${c.origin.reason}`}
      </p>
      {(c.status === "pending" || c.status === "approved") && (
        <form onSubmit={transition}>
          <label>
            Action
            <select name="action">
              <option value="correct">Correct duration</option>
              {c.status === "pending" && (
                <option value="approve">Approve</option>
              )}
            </select>
          </label>
          <label>
            Corrected minutes
            <input name="minutes" type="number" min="1" max="1440" />
          </label>
          <label>
            Reason for correction
            <input name="reason" maxLength={2000} />
            <span>
              Explain the correction using the source evidence or your staff
              knowledge.
            </span>
          </label>
          <button type="submit">Update contribution</button>
        </form>
      )}
    </Card>
  );
}
function Needs({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (
      await mutate(
        productEndpoints.need,
        {
          schemaVersion: 1,
          idempotencyKey: key(),
          category: String(f.get("category")),
          urgency: String(f.get("urgency")),
          summary: String(f.get("summary")),
          provisional: f.get("provisional") === "on",
          dueAt: instant(f.get("due")),
          acknowledgeBy: instant(f.get("acknowledgeBy")),
          origin: { kind: "staff", reason: String(f.get("reason")) },
        },
        "Need created.",
      )
    )
      form.reset();
  }
  return (
    <>
      <h1>Needs board</h1>
      <p>Track ownership, acknowledgment and resolution.</p>
      <Card>
        <h2>Create a need</h2>
        <form onSubmit={create}>
          <label>
            Category
            <input name="category" required maxLength={100} />
          </label>
          <label>
            Summary
            <textarea name="summary" required maxLength={2000} />
          </label>
          <label>
            Urgency
            <select name="urgency">
              <option value="routine">Routine</option>
              <option value="urgent">Urgent</option>
            </select>
          </label>
          <label>
            Due by
            <input name="due" type="datetime-local" />
          </label>
          <label>
            Acknowledge by
            <input name="acknowledgeBy" type="datetime-local" />
          </label>
          <label>
            <input name="provisional" type="checkbox" /> Provisional
          </label>
          <label>
            Reason for staff entry
            <input name="reason" required maxLength={2000} />
          </label>
          <button type="submit">Create need</button>
        </form>
      </Card>
      {snapshot.needs.length ? (
        snapshot.needs.map((n) => (
          <Need
            key={`${n.needId}-${n.revision}`}
            need={n}
            members={snapshot.members}
            mutate={mutate}
          />
        ))
      ) : (
        <p>No needs yet.</p>
      )}
    </>
  );
}
function Need({
  need: n,
  members,
  mutate,
}: {
  need: NeedRecord;
  members: WorkspaceSnapshot["members"];
  mutate: Mutate;
}) {
  const [action, setAction] = useState(
    n.status === "resolved" || n.status === "cancelled" ? "reopen" : "assign",
  );
  async function transition(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const base = {
      schemaVersion: 1,
      idempotencyKey: key(),
      needId: n.needId,
      expectedRevision: n.revision,
      action,
    };
    const body =
      action === "assign"
        ? {
            ...base,
            ownerMembershipId: String(f.get("owner")),
            acknowledgeBy: instant(f.get("acknowledgeBy")),
          }
        : action === "resolve"
          ? { ...base, resolution: String(f.get("reason")) }
          : action === "cancel" || action === "reopen"
            ? { ...base, reason: String(f.get("reason")) }
            : base;
    await mutate(productEndpoints.needTransition, body, "Need updated.");
  }
  const open =
    n.status === "new" ||
    n.status === "assigned" ||
    n.status === "acknowledged";
  return (
    <Card>
      <h2>{n.summary}</h2>
      <p>
        {n.category} · {n.urgency} · {n.status}
        {n.provisional ? " · Provisional" : ""} · revision {n.revision}
      </p>
      <p>
        Owner:{" "}
        {members.find((m) => m.membershipId === n.ownerMembershipId)?.name ??
          (n.ownerMembershipId ? "Assigned member" : "Unassigned")}{" "}
        · Due: {date(n.dueAt)} · Acknowledge by: {date(n.acknowledgeBy)}
      </p>
      <p>
        Acknowledged: {date(n.acknowledgedAt)}
        {n.resolution && ` · Resolution: ${n.resolution}`}
      </p>
      <form onSubmit={transition}>
        <label>
          Action
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            {open && <option value="assign">Assign</option>}
            {n.status === "assigned" && (
              <option value="acknowledge">Acknowledge</option>
            )}
            {open && <option value="resolve">Resolve</option>}
            {open && <option value="cancel">Cancel</option>}
            {!open && <option value="reopen">Reopen</option>}
          </select>
        </label>
        {action === "assign" && (
          <>
            <label>
              Owner
              <select name="owner" required defaultValue="">
                <option value="" disabled>
                  Select a member
                </option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Acknowledge by
              <input name="acknowledgeBy" type="datetime-local" />
            </label>
          </>
        )}
        {["resolve", "cancel", "reopen"].includes(action) && (
          <label>
            {action === "resolve" ? "Resolution" : "Reason"}
            <textarea name="reason" required maxLength={2000} />
          </label>
        )}
        <button type="submit">Update need</button>
      </form>
    </Card>
  );
}
type ImportDraft = {
  format: "json" | "csv" | "whatsapp";
  text: string;
  dateFormat: "ISO" | "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY";
  timezone: string;
  authorMapping: Record<string, string | null>;
  photoMapping?: Record<string, string[]>;
};
type ImportPreview = {
  sources: SourceEnvelope[];
  errors: Array<{ row: number; code: string; message: string }>;
  ambiguousDuplicates: Array<{ sourceIds: string[]; rows: number[] }>;
};
async function importRequest<T>(
  path: string,
  data: object,
  files: File[],
): Promise<ResponseResult<T>> {
  if (!files.length) return request<T>(path, data);
  try {
    const form = new FormData();
    form.set("data", JSON.stringify(data));
    for (const file of files) form.append("files", file, file.name);
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    const result = (await response.json()) as ResponseResult<T>;
    if (result && typeof result.ok === "boolean") return result;
  } catch {}
  return { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } };
}
function Import({ members }: { members: WorkspaceSnapshot["members"] }) {
  const [format, setFormat] = useState<ImportDraft["format"]>("csv");
  const [text, setText] = useState("");
  const [dateFormat, setDateFormat] =
    useState<ImportDraft["dateFormat"]>("ISO");
  const [timezone, setTimezone] = useState("UTC");
  const [mappingText, setMappingText] = useState("{}");
  const [photoMappingText, setPhotoMappingText] = useState("{}");
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<string | null>(null);
  function invalidate() {
    setPreview(null);
    setDraft(null);
    setAck(false);
    setReceipts(null);
    attempt.current = null;
  }
  async function previewImport(e: FormEvent) {
    e.preventDefault();
    let authorMapping: Record<string, string | null>;
    try {
      const parsed: unknown = JSON.parse(mappingText);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.values(parsed).some(
          (v) =>
            v !== null &&
            (typeof v !== "string" ||
              !members.some((m) => m.membershipId === v)),
        )
      )
        throw new Error();
      authorMapping = parsed as Record<string, string | null>;
    } catch {
      setError(
        "Author mapping must be a JSON object of author names to listed member IDs or null.",
      );
      return;
    }
    let photoMapping: Record<string, string[]>;
    try {
      const parsed: unknown = JSON.parse(photoMappingText);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        Object.entries(parsed).some(
          ([name, value]) =>
            !name ||
            !Array.isArray(value) ||
            value.some((v) => typeof v !== "string" || !v),
        )
      )
        throw new Error();
      photoMapping = parsed as Record<string, string[]>;
    } catch {
      setError(
        "Photo mapping must be a JSON object of external IDs to arrays of filenames.",
      );
      return;
    }
    if (
      files.length > 10 ||
      files.some(
        (file) =>
          file.size > 10 * 1024 * 1024 ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.type),
      ) ||
      new Set(files.map((file) => file.name)).size !== files.length
    ) {
      setError(
        "Choose up to 10 PNG, JPEG or WebP photos, each up to 10 MB, with unique filenames.",
      );
      return;
    }
    const next: ImportDraft = {
      format,
      text,
      dateFormat,
      timezone,
      authorMapping,
      ...(Object.keys(photoMapping).length ? { photoMapping } : {}),
    };
    setPending(true);
    setError("");
    const result = await importRequest<ImportPreview>(
      "/api/product/import-preview",
      next,
      files,
    );
    if (result.ok) {
      setDraft(next);
      setPreview(result.value);
      setAck(false);
      attempt.current = null;
    } else setError(errorMessage(result.error.code));
    setPending(false);
  }
  async function confirm() {
    if (
      !preview ||
      !draft ||
      preview.errors.length ||
      (preview.ambiguousDuplicates.length && !ack)
    )
      return;
    attempt.current ??= key();
    setPending(true);
    setError("");
    const result = await importRequest<{ receipts: Receipt[] }>(
      "/api/product/import",
      {
        ...draft,
        idempotencyKey: attempt.current,
        ...(ack ? { allowAmbiguous: true } : {}),
      },
      files,
    );
    if (result.ok) {
      setReceipts(result.value.receipts);
      setPreview(null);
      setDraft(null);
      attempt.current = null;
    } else setError(errorMessage(result.error.code));
    setPending(false);
  }
  return (
    <>
      <h1>Import updates</h1>
      <p>
        Preview rows and author mappings before submitting. Possible duplicates
        are preserved for review.
      </p>
      <Card>
        <form onSubmit={previewImport} onChange={invalidate}>
          <label>
            Format
            <select
              value={format}
              onChange={(e) =>
                setFormat(e.target.value as ImportDraft["format"])
              }
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <label>
            Text file (JSON, CSV or TXT, up to 5 MB)
            <input
              type="file"
              accept=".json,.csv,.txt,application/json,text/csv,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (
                  file.size > 5 * 1024 * 1024 ||
                  !/\.(json|csv|txt)$/i.test(file.name)
                ) {
                  setError("Choose a JSON, CSV or TXT file up to 5 MB.");
                  return;
                }
                setReading(true);
                try {
                  setText(await file.text());
                  setError("");
                } catch {
                  setError("Could not read the selected file.");
                } finally {
                  setReading(false);
                }
              }}
            />
          </label>
          <label>
            Photos (up to 10 PNG, JPEG or WebP files, each up to 10 MB)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <label>
            Photo mapping (JSON: external ID to filename array; optional)
            <textarea
              value={photoMappingText}
              onChange={(e) => setPhotoMappingText(e.target.value)}
            />
          </label>
          <label>
            Import text
            <textarea
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
            />
          </label>
          <label>
            Date format
            <select
              value={dateFormat}
              onChange={(e) =>
                setDateFormat(e.target.value as ImportDraft["dateFormat"])
              }
            >
              <option>ISO</option>
              <option>YYYY-MM-DD</option>
              <option>MM/DD/YYYY</option>
              <option>DD/MM/YYYY</option>
            </select>
          </label>
          <label>
            Timezone
            <input
              required
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            />
          </label>
          <label>
            Author mapping (JSON: author name to member ID or null)
            <textarea
              value={mappingText}
              onChange={(e) => setMappingText(e.target.value)}
            />
          </label>
          <p>
            Available member IDs:{" "}
            {members.length
              ? members.map((m) => `${m.name}: ${m.membershipId}`).join(", ")
              : "None"}
          </p>
          <p>Default fields: id, author, text, timestamp.</p>
          <button type="submit" disabled={pending || reading}>
            Preview import
          </button>
        </form>
      </Card>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <Card>
          <h2>Preview</h2>
          <p>{preview.sources.length} sources ready to review.</p>
          <ul>
            {preview.sources.map((source) => (
              <li key={`${source.sourceId}-${source.revision}`}>
                {source.author.externalIdentity}: {source.text} ·{" "}
                {source.attachments.length} attachments
              </li>
            ))}
          </ul>
          {preview.errors.length > 0 && (
            <>
              <h3>Errors</h3>
              <ul>
                {preview.errors.map((e) => (
                  <li key={`${e.row}-${e.code}-${e.message}`}>
                    Row {e.row}: {e.message} ({e.code})
                  </li>
                ))}
              </ul>
              <p>Fix errors before confirming.</p>
            </>
          )}
          {preview.ambiguousDuplicates.length > 0 && (
            <>
              <h3>Possible duplicates</h3>
              <ul>
                {preview.ambiguousDuplicates.map((d) => (
                  <li key={JSON.stringify(d)}>
                    Rows {d.rows.join(", ")} · sources {d.sourceIds.join(", ")}
                  </li>
                ))}
              </ul>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => {
                    setAck(e.target.checked);
                    attempt.current = null;
                  }}
                />{" "}
                Preserve possible duplicates for review
              </label>
            </>
          )}
          <button
            type="button"
            disabled={
              pending ||
              preview.errors.length > 0 ||
              (preview.ambiguousDuplicates.length > 0 && !ack)
            }
            onClick={() => void confirm()}
          >
            Confirm import
          </button>
        </Card>
      )}
      {receipts && (
        <Card>
          <h2>Import received</h2>
          <p>{receipts.length} updates received.</p>
          <ul>
            {receipts.map((r) => (
              <li key={`${r.sourceId}-${r.revision}`}>
                {r.sourceId} · revision {r.revision}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
function Summary({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<ProductReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setLoading(true);
    void request<ProductReport>(
      `/api/product/reports${query ? `?${query}` : ""}`,
    ).then((result) => {
      if (!live) return;
      if (result.ok) {
        setReport(result.value);
        setError("");
      } else {
        setReport(null);
        setError(errorMessage(result.error.code));
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [query]);
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const draft = Object.fromEntries(
      ["from", "to", "program", "membershipId"]
        .map((name) => [name, String(f.get(name) || "").trim()])
        .filter(([, value]) => value),
    );
    const parsed = reportQuerySchema.safeParse(draft);
    if (!parsed.success) {
      setError("Check the date range and filters.");
      return;
    }
    setError("");
    setQuery(
      new URLSearchParams(
        Object.entries(parsed.data).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ).toString(),
    );
  }
  const s = report?.ledger;
  return (
    <>
      <h1>Summary</h1>
      <p>Only approved contributions count toward recorded time.</p>
      <Card>
        <h2>Filter report</h2>
        <form onSubmit={apply}>
          <label>
            From date
            <input type="date" name="from" />
          </label>
          <label>
            To date
            <input type="date" name="to" />
          </label>
          <label>
            Program
            <input name="program" maxLength={100} />
          </label>
          {snapshot.organization.role !== "report-reader" && (
            <label>
              Volunteer
              <select name="membershipId">
                <option value="">All volunteers</option>
                {snapshot.members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit">Apply filters</button>
        </form>
      </Card>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p aria-live="polite">Loading report…</p>
      ) : report && s ? (
        <>
          <p>Timezone: {report.timezone}</p>
          <a href={`/api/product/reports.csv${query ? `?${query}` : ""}`}>
            Download aggregate CSV
          </a>
          <div className={styles.metrics}>
            <Card>
              <h2>Approved minutes</h2>
              <p>{s.approvedMinutes}</p>
            </Card>
            <Card>
              <h2>Approved hours</h2>
              <p>{report.approvedHours}</p>
            </Card>
            <Card>
              <h2>Approved contributions</h2>
              <p>{s.approvedContributions}</p>
            </Card>
            <Card>
              <h2>Activities with approved contributions</h2>
              <p>{s.activitiesWithApprovedContributions}</p>
            </Card>
            <Card>
              <h2>Pending contributions</h2>
              <p>{s.pendingContributions}</p>
              <p>
                {s.pendingUnknownDuration} with unknown duration ·{" "}
                {s.pendingUnresolvedVolunteer} with unresolved volunteer
              </p>
            </Card>
            <Card>
              <h2>Needs</h2>
              <p>
                {report.openNeeds} open · {report.resolvedNeeds} resolved
              </p>
            </Card>
            <Card>
              <h2>Average acknowledgment time</h2>
              <p>
                {report.averageAcknowledgmentMinutes === null
                  ? "Unknown"
                  : `${report.averageAcknowledgmentMinutes} minutes`}
              </p>
            </Card>
            <Card>
              <h2>Average resolution time</h2>
              <p>
                {report.averageResolutionMinutes == null
                  ? "Unknown"
                  : `${report.averageResolutionMinutes} minutes`}
              </p>
            </Card>
            <Card>
              <h2>Unknown dates excluded</h2>
              <p>{report.excludedUnknownDate}</p>
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
