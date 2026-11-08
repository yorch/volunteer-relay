"use client";

import {
  type ContributionRecord,
  type NeedRecord,
  productEndpoints,
  type ReviewQueueEntry,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { loadOrganizations, mutateAuth } from "../auth/transport";
import { StaffShell, VolunteerShell } from "../layout";
import styles from "./product.module.css";

type Page = "volunteer" | "inbox" | "activities" | "needs" | "reports";
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
    const result = await request<unknown>(endpoint, body);
    if (!result.ok) {
      setError(errorMessage(result.error.code));
      return false;
    }
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
    activePage === "volunteer"
      ? role === "volunteer"
      : activePage === "reports"
        ? role === "report-reader" || staff
        : staff;
  const nav = staff
    ? [
        { href: "/workspace/inbox", label: "Source inbox" },
        { href: "/workspace/activities", label: "Activities" },
        { href: "/workspace/needs", label: "Needs" },
        { href: "/workspace/reports", label: "Summary" },
      ]
    : [{ href: "/workspace/reports", label: "Summary" }];
  const content = (
    <>
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
        <Volunteer snapshot={snapshot} mutate={mutate} />
      ) : activePage === "inbox" ? (
        <Inbox snapshot={snapshot} mutate={mutate} />
      ) : activePage === "activities" ? (
        <Activities snapshot={snapshot} mutate={mutate} />
      ) : activePage === "needs" ? (
        <Needs snapshot={snapshot} mutate={mutate} />
      ) : (
        <Summary snapshot={snapshot} />
      )}
    </>
  );
  return role === "volunteer" ? (
    <VolunteerShell
      organization={snapshot.organization.name}
      mainId="workspace-main"
      account={<Organization />}
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
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  const [text, setText] = useState("");
  const [receipt, setReceipt] = useState("");
  const [pending, setPending] = useState(false);
  const [submissionKey, setSubmissionKey] = useState(key);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
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
            onChange={(e) => setText(e.target.value)}
            rows={6}
          />
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
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const entry =
    snapshot.queue.find((e) => e.proposal.runId === selected) ??
    snapshot.queue[0];
  async function decide(
    entry: ReviewQueueEntry,
    decision: "accept" | "reject",
  ) {
    setPending(true);
    if (
      await mutate(
        productEndpoints.review,
        {
          runId: entry.proposal.runId,
          expectedRevision: entry.revision,
          idempotencyKey: key(),
          decision,
          reason,
        },
        `Proposal ${decision === "accept" ? "accepted" : "rejected"}.`,
      )
    ) {
      setSelected(null);
      setReason("");
    }
    setPending(false);
  }
  return (
    <>
      <h1>Source inbox</h1>
      <p>Review the original update alongside its proposed fields.</p>
      {!entry ? (
        <p>No sources awaiting review.</p>
      ) : (
        <div className={styles.columns}>
          <Card>
            <h2>Awaiting review</h2>
            <ul className={styles.list}>
              {snapshot.queue.map((item) => (
                <li key={item.proposal.runId}>
                  <button
                    type="button"
                    aria-pressed={entry.proposal.runId === item.proposal.runId}
                    onClick={() => {
                      setSelected(item.proposal.runId);
                      setReason("");
                    }}
                  >
                    Source {item.source.sourceId} · revision{" "}
                    {item.source.revision}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
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
            <h3>Proposed fields</h3>
            {entry.proposal.items.length ? (
              entry.proposal.items.map((item) => (
                <div className={styles.item} key={item.key}>
                  <strong>{item.kind}</strong>
                  <dl>
                    {Object.entries(item)
                      .filter(
                        ([name]) => !["kind", "key", "evidence"].includes(name),
                      )
                      .map(([name, value]) => (
                        <div key={name}>
                          <dt>{name}</dt>
                          <dd>{value === null ? "Unknown" : String(value)}</dd>
                        </div>
                      ))}
                  </dl>
                  <p>Evidence:</p>
                  <ul>
                    {item.evidence.map((e) => (
                      <li key={JSON.stringify(e)}>
                        {e.field}:{" "}
                        {e.kind === "text" ? `“${e.quote}”` : e.observation}{" "}
                        (source revision {e.sourceRevision})
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
                <h3>Unresolved</h3>
                <ul>
                  {entry.proposal.unresolved.map((u) => (
                    <li key={JSON.stringify(u)}>
                      {u.field}: {u.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <label htmlFor="review-reason">Review reason</label>
            <textarea
              id="review-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className={styles.actions}>
              <button
                disabled={pending}
                type="button"
                onClick={() => void decide(entry, "accept")}
              >
                Accept proposal
              </button>
              <button
                disabled={pending || !reason.trim()}
                type="button"
                onClick={() => void decide(entry, "reject")}
              >
                Reject proposal
              </button>
            </div>
            <p>
              Rejecting a proposal does not automatically withdraw a provisional
              need.
            </p>
          </Card>
        </div>
      )}
    </>
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
function Summary({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const s = snapshot.summary;
  return (
    <>
      <h1>Summary</h1>
      <p>Only approved contributions count toward recorded time.</p>
      {s ? (
        <div className={styles.metrics}>
          <Card>
            <h2>Approved minutes</h2>
            <p>{s.approvedMinutes}</p>
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
        </div>
      ) : (
        <p>Summary is unavailable.</p>
      )}
    </>
  );
}
