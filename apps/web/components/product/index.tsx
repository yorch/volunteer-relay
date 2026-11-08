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
import {
  errorMessage,
  onWorkspaceChanged,
  request,
  setRenderedOrganization,
} from "../api-client";
import { loadOrganizations, mutateAuth } from "../auth/transport";
import { Card as BaseCard, Live } from "../card";
import { StaffShell, VolunteerShell } from "../layout";
import { splitOrganizationHint } from "../org-hint";
import { Members, Notifications, Settings } from "./admin";
import { Delivery, History } from "./operations";
import styles from "./product.module.css";
import { Retention } from "./retention";

type Page =
  | "home"
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
  | "delivery"
  | "retention";
const key = () => crypto.randomUUID();
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "Not set";
const duration = (minutes: number | null) => {
  if (minutes === null) return "Unknown";
  const rounded = Math.round(minutes);
  return rounded < 60
    ? `${rounded} min`
    : `${Math.floor(rounded / 60)} hr ${rounded % 60} min`;
};
const fieldLabel = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());
const instant = (value: FormDataEntryValue | null) => {
  if (!value) return null;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
};
function Organization() {
  const [choices, setChoices] = useState<Awaited<
    ReturnType<typeof loadOrganizations>
  > | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let live = true;
    void loadOrganizations().then((result) => {
      if (live) setChoices(result);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!choices?.ok || choices.value.options.length < 2)
    return <a href="/account">Account</a>;
  return (
    <div>
      <label htmlFor="organization">Organization</label>
      <select
        id="organization"
        value={choices.value.currentOrganizationId ?? ""}
        disabled={pending}
        aria-busy={pending}
        onChange={async (e) => {
          if (pending) return;
          const organizationId = e.target.value;
          setPending(true);
          setError("");
          const result = await mutateAuth("organizations/select", {
            organizationId,
          });
          if (result.ok) window.location.href = "/workspace";
          else {
            setError(errorMessage(result.error.code));
            setPending(false);
          }
        }}
      >
        {choices.value.options.map((option) => (
          <option key={option.organizationId} value={option.organizationId}>
            {option.name}
          </option>
        ))}
      </select>
      <p role="alert">{error}</p>
      <a href="/account">Account</a>
    </div>
  );
}
type OrgOption = { organizationId: string; name: string; role: string };
function OrganizationPicker({ options }: { options: readonly OrgOption[] }) {
  const [chosen, setChosen] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className={styles.standalone}>
      <h1>Choose an organization</h1>
      <form
        aria-label="Choose an organization"
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || !chosen) return;
          setPending(true);
          setError("");
          const result = await mutateAuth("organizations/select", {
            organizationId: chosen,
          });
          if (result.ok) window.location.href = "/workspace";
          else {
            setError(errorMessage(result.error.code));
            setPending(false);
          }
        }}
      >
        <fieldset disabled={pending}>
          <legend>Select an organization to open its workspace.</legend>
          {options.map((option) => (
            <label key={option.organizationId} style={{ display: "block" }}>
              <input
                type="radio"
                name="organizationId"
                value={option.organizationId}
                checked={chosen === option.organizationId}
                onChange={() => setChosen(option.organizationId)}
              />{" "}
              {option.name} ({option.role})
            </label>
          ))}
        </fieldset>
        <Live kind="alert">{error}</Live>
        <button type="submit" disabled={pending || !chosen}>
          {pending ? "Opening…" : "Open workspace"}
        </button>
      </form>
    </main>
  );
}
function NoOrganization() {
  const [error, setError] = useState("");
  return (
    <main className={styles.standalone}>
      <h1>You&apos;re not in an organization yet</h1>
      <p>
        An owner or coordinator needs to invite you. Check your email for an
        invitation, and make sure your email address is{" "}
        <a href="/verify-email">verified</a>. Then open the invitation link to
        join.
      </p>
      <Live kind="alert">{error}</Live>
      <button
        type="button"
        onClick={async () => {
          setError("");
          const result = await mutateAuth("sign-out", {});
          if (result.ok) window.location.assign("/sign-in");
          else setError(errorMessage(result.error.code));
        }}
      >
        Sign out
      </button>
    </main>
  );
}
export function ProductWorkspace({ page }: { page: Page | "home" }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgOptions, setOrgOptions] = useState<readonly OrgOption[] | null>(
    null,
  );
  const [noOrganization, setNoOrganization] = useState(false);
  const [workspaceChanged, setWorkspaceChanged] = useState(false);
  const hintResolved = useRef(false);
  useEffect(() => onWorkspaceChanged(() => setWorkspaceChanged(true)), []);
  const [error, setError] = useState("");
  // Kept beside the message so the recovery link can match the reason: a
  // signed-in user without usable membership must not be sent to /sign-in,
  // which redirects them straight back here.
  const [errorCode, setErrorCode] = useState("");
  const [notice, setNotice] = useState("");
  const attempts = useRef<Record<string, { signature: string; key: string }>>(
    {},
  );
  const refresh = useCallback(async () => {
    const result = await request<WorkspaceSnapshot>(productEndpoints.workspace);
    setOrgOptions(null);
    setNoOrganization(false);
    setRenderedOrganization(
      result.ok ? result.value.organization.organizationId : null,
    );
    if (result.ok) {
      setSnapshot(result.value);
      setError("");
      setErrorCode("");
    } else {
      setSnapshot(null);
      setError(errorMessage(result.error.code));
      setErrorCode(result.error.code);
      if (result.error.code === "FORBIDDEN") {
        const choices = await loadOrganizations();
        if (choices.ok && choices.value.currentOrganizationId === null) {
          if (choices.value.options.length > 0)
            setOrgOptions(choices.value.options);
          else setNoOrganization(true);
        }
      }
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    // Run once (also under StrictMode): resolve a deep-link ?org= hint before
    // any snapshot is fetched so another organization's data never flashes.
    if (hintResolved.current) return;
    hintResolved.current = true;
    const { present, hint, rest } = splitOrganizationHint(
      window.location.search,
    );
    if (!present) {
      void refresh();
      return;
    }
    const clean = `${window.location.pathname}${rest}${window.location.hash}`;
    window.history.replaceState(null, "", clean);
    if (!hint) {
      void refresh();
      return;
    }
    void (async () => {
      const choices = await loadOrganizations();
      const current = choices.ok ? choices.value.currentOrganizationId : null;
      if (current !== hint) {
        const selected = await mutateAuth("organizations/select", {
          organizationId: hint,
        });
        // The URL no longer carries the hint, so this reload cannot loop.
        if (selected.ok) {
          window.location.replace(clean);
          return;
        }
      }
      await refresh();
    })();
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
  if (!snapshot && orgOptions)
    return <OrganizationPicker options={orgOptions} />;
  if (!snapshot && noOrganization) return <NoOrganization />;
  if (!snapshot)
    return (
      <main className={styles.standalone}>
        <h1>Workspace unavailable</h1>
        <p role="alert">{error}</p>
        {errorCode === "FORBIDDEN" ? (
          <a href="/account">Choose an organization or sign out</a>
        ) : (
          <a href="/sign-in">Sign in</a>
        )}{" "}
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
        ? "home"
        : role === "volunteer"
          ? "volunteer"
          : "reports"
      : page;
  const allowed =
    activePage === "notifications"
      ? true
      : activePage === "members" || activePage === "retention"
        ? role === "owner"
        : activePage === "volunteer"
          ? role === "volunteer"
          : activePage === "reports"
            ? role === "report-reader" || staff
            : staff;
  const nav = staff
    ? [
        { href: "/workspace", icon: "workspace", label: "Overview" },
        { href: "/workspace/inbox", icon: "inbox", label: "Source inbox" },
        {
          href: "/workspace/activities",
          icon: "activities",
          label: "Activities",
        },
        { href: "/workspace/needs", icon: "needs", label: "Needs" },
        { href: "/workspace/import", icon: "import", label: "Import" },
        { href: "/workspace/reports", icon: "reports", label: "Summary" },
        { href: "/workspace/settings", icon: "settings", label: "Settings" },
        { href: "/workspace/history", icon: "history", label: "History" },
        { href: "/workspace/delivery", icon: "delivery", label: "Delivery" },
        ...(role === "owner"
          ? [
              { href: "/workspace/members", icon: "members", label: "Members" },
              {
                href: "/workspace/retention",
                icon: "retention",
                label: "Retention",
              },
            ]
          : []),
        {
          href: "/workspace/notifications",
          icon: "notifications",
          label: "Notifications",
        },
      ]
    : [
        { href: "/workspace/reports", icon: "reports", label: "Summary" },
        {
          href: "/workspace/notifications",
          icon: "notifications",
          label: "Notifications",
        },
      ];
  const content = (
    <div
      onChangeCapture={() => {
        attempts.current = {};
      }}
    >
      {workspaceChanged && (
        <div role="alert" className={styles.error}>
          <p>The workspace changed in another tab. Refresh to continue.</p>
          <button
            type="button"
            onClick={() => window.location.assign("/workspace")}
          >
            Reload workspace
          </button>
        </div>
      )}
      <Live kind="alert" className={styles.error}>
        {error}
      </Live>
      <Live kind="status" className={styles.notice}>
        {notice}
      </Live>
      {!allowed ? (
        <>
          <h1>Permission denied</h1>
          <p>Your role does not have access to this page.</p>
          <a href="/workspace">Go to your workspace</a>
        </>
      ) : activePage === "home" ? (
        <Overview snapshot={snapshot} />
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
      ) : activePage === "retention" ? (
        <Retention mutate={mutate} />
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
      currentPath={
        activePage === "home" ? "/workspace" : `/workspace/${activePage}`
      }
      navigation={nav}
      account={
        <>
          {snapshot.members.find(
            (m) => m.membershipId === snapshot.organization.membershipId,
          )?.name && (
            <span>
              {
                snapshot.members.find(
                  (m) => m.membershipId === snapshot.organization.membershipId,
                )?.name
              }{" "}
              · {role}
              {" · "}
            </span>
          )}
          <Organization />
        </>
      }
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
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}
function Overview({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const [report, setReport] = useState<ProductReport | null>(null);
  const [reportError, setReportError] = useState(false);
  useEffect(() => {
    let live = true;
    void request<ProductReport>("/api/product/reports").then((result) => {
      if (!live) return;
      if (result.ok) setReport(result.value);
      else setReportError(true);
    });
    return () => {
      live = false;
    };
  }, []);
  const openNeeds = snapshot.needs
    .filter((n) => ["new", "assigned", "acknowledged"].includes(n.status))
    .sort(
      (a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"),
    );
  const failed = snapshot.sources.filter((s) => s.status === "failed").length;
  return (
    <>
      <div className={styles.pageHeader}>
        <div>
          <span className={styles.eyebrow}>Your workspace</span>
          <h1>Overview</h1>
          <p>Here's what needs your attention today.</p>
        </div>
        <a className={styles.primaryLink} href="/workspace/inbox">
          Review updates <span aria-hidden="true">→</span>
        </a>
      </div>
      <div className={styles.metrics}>
        <Card>
          <span className={styles.eyebrow}>Awaiting review</span>
          <p className={styles.metricValue}>{snapshot.queue.length}</p>
          <p>Updates ready for a decision</p>
          <a href="/workspace/inbox">Open inbox</a>
        </Card>
        <Card>
          <span className={styles.eyebrow}>Open needs</span>
          <p className={styles.metricValue}>{openNeeds.length}</p>
          <p>Needs being tracked</p>
          <a href="/workspace/needs">View needs</a>
        </Card>
        <Card>
          <span className={styles.eyebrow}>Approved time</span>
          <p className={styles.metricValue}>
            {report ? `${report.approvedHours} hrs` : "—"}
          </p>
          <p>
            {reportError
              ? "Report unavailable"
              : report
                ? "From approved contributions"
                : "Loading report…"}
          </p>
          <a href="/workspace/reports">View summary</a>
        </Card>
      </div>
      <div className={styles.overviewGrid}>
        <Card>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Up next</span>
              <h2>Priorities</h2>
            </div>
            <a href="/workspace/inbox">View inbox</a>
          </div>
          {snapshot.queue.length > 0 && (
            <p className={styles.priority}>
              <strong>{snapshot.queue.length} updates awaiting review</strong>
              <br />
              <span>
                Compare the proposed fields with the original evidence.
              </span>
            </p>
          )}
          {failed > 0 && (
            <p className={styles.priority}>
              <strong>
                {failed} processing {failed === 1 ? "failure" : "failures"}
              </strong>
              <br />
              <span>Inspect the original update and retry processing.</span>
            </p>
          )}
          {openNeeds.filter((n) => n.urgency === "urgent").length > 0 && (
            <p className={styles.priority}>
              <strong>
                {openNeeds.filter((n) => n.urgency === "urgent").length} urgent{" "}
                {openNeeds.filter((n) => n.urgency === "urgent").length === 1
                  ? "need"
                  : "needs"}
              </strong>
              <br />
              <span>Check ownership and next steps on the needs board.</span>
            </p>
          )}
          {!snapshot.queue.length &&
            !failed &&
            !openNeeds.some((n) => n.urgency === "urgent") && (
              <p>No urgent work right now.</p>
            )}
        </Card>
        <Card>
          <div className={styles.sectionHeading}>
            <div>
              <span className={styles.eyebrow}>Keep things moving</span>
              <h2>Open needs</h2>
            </div>
            <a href="/workspace/needs">View board</a>
          </div>
          {openNeeds.length ? (
            openNeeds.slice(0, 4).map((n) => (
              <p className={styles.priority} key={n.needId}>
                <strong>{n.summary}</strong>
                <br />
                <span>
                  {n.status} · {n.provisional ? "Provisional · " : ""}Due{" "}
                  {date(n.dueAt)}
                </span>
              </p>
            ))
          ) : (
            <p>No open needs.</p>
          )}
        </Card>
      </div>
    </>
  );
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
  const [sourceId, setSourceId] = useState<string | null>(null);
  const sourceTrigger = useRef<HTMLButtonElement | null>(null);
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
      const result = await request<Receipt>("/api/product/source-photo", form);
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
      <span className={styles.eyebrow}>Your volunteer workspace</span>
      <h1>How did you help today?</h1>
      <p>Share an update with your team.</p>
      <div className={styles.volunteerForm}>
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
              placeholder="Tell your team what you did, when it happened, and how long you spent."
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
            <Live kind="alert">{photoError}</Live>
            <button disabled={pending} type="submit">
              {pending ? "Sending…" : "Send update"}
            </button>
          </form>
          <Live kind="polite" className={styles.notice}>
            {receipt}
          </Live>
        </Card>
      </div>
      <Card>
        <h2>Your updates</h2>
        {snapshot.sources.length ? (
          <ul className={styles.updateList}>
            {snapshot.sources.map((source) => (
              <li key={source.sourceId}>
                <div className={styles.updateHeading}>
                  <strong>
                    {source.preview?.trim() || "Update without a text preview"}
                  </strong>
                  <span className={styles.badge}>{source.status}</span>
                </div>
                <p>
                  {source.receivedAt
                    ? `Received ${date(source.receivedAt)}`
                    : "Received date unavailable"}
                </p>
                <button
                  type="button"
                  onClick={(event) => {
                    sourceTrigger.current = event.currentTarget;
                    setSourceId(source.sourceId);
                  }}
                >
                  View my update
                </button>
                <details>
                  <summary>Receipt details</summary>
                  <p>
                    Update {source.sourceId} · revision {source.revision}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p>No updates yet.</p>
        )}
      </Card>
      {sourceId && (
        <PendingSource
          key={sourceId}
          sourceId={sourceId}
          status="your update"
          close={() => {
            setSourceId(null);
            requestAnimationFrame(() => sourceTrigger.current?.focus());
          }}
        />
      )}
      <Card>
        <h2>Your contributions</h2>
        <ContributionList
          contributions={snapshot.contributions}
          members={snapshot.members}
        />
      </Card>
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
  return (
    <>
      <h1>Source inbox</h1>
      <p>Review the original update alongside its proposed fields.</p>
      <nav className={styles.filterTabs} aria-label="Update status">
        {(["review", "queued", "failed"] as const).map((status) => (
          <button
            key={status}
            type="button"
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
                  <li key={source.sourceId}>
                    Source {source.sourceId} · revision {source.revision} ·
                    failed{" "}
                    <button
                      type="button"
                      onClick={() => setInspected(source.sourceId)}
                    >
                      Inspect evidence
                    </button>{" "}
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
          <h2>Queued updates</h2>
          {queued.length ? (
            <ul className={styles.list}>
              {queued.map((source) => (
                <li key={source.sourceId}>
                  Source {source.sourceId} · revision {source.revision} · queued{" "}
                  <button
                    type="button"
                    onClick={() => setInspected(source.sourceId)}
                  >
                    Inspect evidence
                  </button>
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
            <ul className={styles.list}>
              {(statusFilter === "queued" ? queued : failed).map((source) => (
                <li key={source.sourceId}>
                  <button
                    type="button"
                    onClick={() => setInspected(source.sourceId)}
                  >
                    Source {source.sourceId} · revision {source.revision}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>Nothing here yet.</p>
          )}
        </Card>
      )}
      {statusFilter === "review" &&
        (snapshot.queue.length === 0 ? (
          <p>No sources awaiting review.</p>
        ) : (
          <div
            className={`${styles.columns} ${entry ? styles.hasSelection : ""}`}
          >
            <div className={styles.inboxList}>
              <Card>
                <h2>
                  Awaiting review{" "}
                  <span className={styles.count}>{snapshot.queue.length}</span>
                </h2>
                <label>
                  Search updates
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
                </label>
                <button type="button" onClick={() => void refresh()}>
                  Refresh inbox
                </button>
                <ul className={styles.list}>
                  {snapshot.queue
                    .filter((item) =>
                      `${item.source.sourceId} ${item.source.text ?? ""}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((item) => (
                      <li key={item.proposal.runId}>
                        <button
                          type="button"
                          aria-pressed={
                            entry?.proposal.runId === item.proposal.runId
                          }
                          onClick={() => setSelected(item.proposal.runId)}
                        >
                          <strong>
                            {item.source.text?.slice(0, 90) ||
                              "Update without text"}
                          </strong>
                          <br />
                          <small>
                            Source {item.source.sourceId} · revision{" "}
                            {item.source.revision}
                          </small>
                        </button>
                      </li>
                    ))}
                </ul>
              </Card>
            </div>
            {entry ? (
              <div>
                <button
                  type="button"
                  className={styles.backToInbox}
                  ref={backButton}
                  onClick={() => {
                    setSelected(null);
                    requestAnimationFrame(() => searchInput.current?.focus());
                  }}
                >
                  Back to inbox
                </button>
                <ReviewEditor
                  key={`${entry.proposal.runId}-${entry.revision}`}
                  entry={entry}
                  members={snapshot.members}
                  mutate={mutate}
                  clear={() => setSelected(null)}
                />
              </div>
            ) : (
              <Card>
                <p>Select a source to review.</p>
              </Card>
            )}
          </div>
        ))}
    </>
  );
}
function PendingSource({
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
    <Card>
      <h2
        className={styles.evidenceHeading}
        ref={evidenceHeading}
        tabIndex={-1}
      >
        Original source evidence
      </h2>
      <p>
        Source {sourceId} · {status}
      </p>
      <button type="button" onClick={close}>
        Close evidence
      </button>
      <Live kind="alert">{error}</Live>
      {error ? null : source ? (
        <>
          <p>
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
    <div className={styles.reviewPanels}>
      <Card>
        <span className={styles.eyebrow}>Source evidence</span>
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
      </Card>
      <Card>
        <span className={styles.eyebrow}>Review and decide</span>
        <h2>Proposed fields</h2>
        {items.length ? (
          items.map((item, index) => (
            <div className={styles.item} key={item.key}>
              <strong>{fieldLabel(item.kind)}</strong>
              <dl>
                {Object.entries(item)
                  .filter(
                    ([name]) => !["kind", "key", "evidence"].includes(name),
                  )
                  .map(([name, value]) => (
                    <div key={name}>
                      <dt>{fieldLabel(name)}</dt>
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
                  <li
                    key={`${e.field}:${e.sourceRevision}:${e.kind === "text" ? e.quote : e.observation}`}
                  >
                    {fieldLabel(e.field)}:{" "}
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
                <li key={`${u.field}:${u.reason}`}>
                  {fieldLabel(u.field)}: {u.reason}
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
          Rejecting a proposal does not automatically withdraw a provisional
          need.
        </p>
      </Card>
    </div>
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
      <h2>Contribution ledger</h2>
      {snapshot.contributions.length ? (
        <div className={styles.ledger}>
          {snapshot.contributions.map((c) => (
            <Contribution
              key={c.contributionId}
              contribution={c}
              activity={snapshot.activities?.find(
                (a) => a.activityId === c.activityId,
              )}
              members={snapshot.members}
              mutate={mutate}
            />
          ))}
        </div>
      ) : (
        <p>No contributions yet.</p>
      )}
      <details className={styles.utilityDisclosure}>
        <summary>Record an activity</summary>
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
      </details>
    </>
  );
}
function Contribution({
  contribution: c,
  activity,
  members,
  mutate,
}: {
  contribution: ContributionRecord;
  activity: NonNullable<WorkspaceSnapshot["activities"]>[number] | undefined;
  members: WorkspaceSnapshot["members"];
  mutate: Mutate;
}) {
  const [showSource, setShowSource] = useState(false);
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
    <div className={styles.ledgerRow}>
      <div className={styles.ledgerMain}>
        <div>
          <strong>
            {activity?.kind || `Activity ${c.activityId.slice(0, 8)}`}
          </strong>
          <p>{activity?.localDate || "Date unknown"}</p>
        </div>
        <p>
          {members.find((m) => m.membershipId === c.membershipId)?.name ??
            (c.membershipId ? "Volunteer" : "Unknown volunteer")}{" "}
          ·{" "}
          {c.durationMinutes === null
            ? "Unknown duration"
            : `${c.durationMinutes} minutes`}{" "}
          · {c.status}
        </p>
      </div>
      {c.origin.kind === "source" && (
        <button
          type="button"
          className={styles.evidenceAction}
          onClick={() => setShowSource(true)}
        >
          Inspect current source evidence
        </button>
      )}
      {showSource && c.origin.kind === "source" && (
        <PendingSource
          sourceId={c.origin.sourceId}
          status="current evidence"
          close={() => setShowSource(false)}
        />
      )}
      <details>
        <summary>Details and correction</summary>
        <p>
          Activity {c.activityId} · contribution revision {c.revision}
        </p>
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
      </details>
    </div>
  );
}
function Needs({
  snapshot,
  mutate,
}: {
  snapshot: WorkspaceSnapshot;
  mutate: Mutate;
}) {
  const [formError, setFormError] = useState("");
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const dueAt = instant(f.get("due"));
    const acknowledgeBy = instant(f.get("acknowledgeBy"));
    if (dueAt === undefined || acknowledgeBy === undefined) {
      setFormError("Enter a valid date and time.");
      return;
    }
    setFormError("");
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
          dueAt,
          acknowledgeBy,
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
      <details className={styles.utilityDisclosure}>
        <summary>Create a need</summary>
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
            <p role="alert">{formError}</p>
            <button type="submit">Create need</button>
          </form>
        </Card>
      </details>
      <div className={styles.board}>
        {(["new", "assigned", "acknowledged"] as const).map((status) => (
          <section className={styles.boardColumn} key={status}>
            <h2>
              {status === "new"
                ? "New"
                : status === "assigned"
                  ? "Assigned"
                  : "Acknowledged"}{" "}
              <span className={styles.count}>
                {snapshot.needs.filter((n) => n.status === status).length}
              </span>
            </h2>
            {snapshot.needs
              .filter((n) => n.status === status)
              .sort(
                (a, b) =>
                  Number(b.urgency === "urgent") -
                  Number(a.urgency === "urgent"),
              )
              .map((n) => (
                <Need
                  key={`${n.needId}-${n.revision}`}
                  need={n}
                  members={snapshot.members}
                  mutate={mutate}
                />
              ))}
            {!snapshot.needs.some((n) => n.status === status) && (
              <p className={styles.empty}>Nothing here yet.</p>
            )}
          </section>
        ))}
      </div>
      <details className={styles.utilityDisclosure}>
        <summary>
          Completed needs (
          {
            snapshot.needs.filter(
              (n) => n.status === "resolved" || n.status === "cancelled",
            ).length
          }
          )
        </summary>
        {snapshot.needs
          .filter((n) => n.status === "resolved" || n.status === "cancelled")
          .map((n) => (
            <Need
              key={`${n.needId}-${n.revision}`}
              need={n}
              members={snapshot.members}
              mutate={mutate}
            />
          ))}
      </details>
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
  const [formError, setFormError] = useState("");
  const [action, setAction] = useState(
    n.status === "resolved" || n.status === "cancelled" ? "reopen" : "assign",
  );
  async function transition(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const acknowledgeBy = instant(f.get("acknowledgeBy"));
    if (action === "assign" && acknowledgeBy === undefined) {
      setFormError("Enter a valid date and time.");
      return;
    }
    setFormError("");
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
            acknowledgeBy,
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
      <div className={styles.badges}>
        <span
          className={n.urgency === "urgent" ? styles.urgentBadge : styles.badge}
        >
          {n.urgency}
        </span>
        {n.provisional && (
          <span className={styles.provisionalBadge}>Provisional</span>
        )}
        <span className={styles.badge}>{n.status}</span>
      </div>
      <p>{n.category}</p>
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
      <details>
        <summary>Manage need</summary>
        <p className={styles.technical}>Revision {n.revision}</p>
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
          <p role="alert">{formError}</p>
          <button type="submit">Update need</button>
        </form>
      </details>
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
function importRequest<T>(path: string, data: object, files: File[]) {
  if (!files.length) return request<T>(path, data);
  const form = new FormData();
  form.set("data", JSON.stringify(data));
  for (const file of files) form.append("files", file, file.name);
  return request<T>(path, form);
}
function Import({ members }: { members: WorkspaceSnapshot["members"] }) {
  const [format, setFormat] = useState<ImportDraft["format"]>("csv");
  const [text, setText] = useState("");
  const [dateFormat, setDateFormat] =
    useState<ImportDraft["dateFormat"]>("ISO");
  const [timezone, setTimezone] = useState("UTC");
  const [authorRows, setAuthorRows] = useState<
    Array<{ rowId: string; author: string; member: string }>
  >([]);
  const [photoRows, setPhotoRows] = useState<
    Array<{ rowId: string; id: string; filenames: string }>
  >([]);
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
    const authorMapping: Record<string, string | null> = Object.create(null);
    for (const row of authorRows) {
      if (!row.author.trim()) {
        setError("Enter a name for each author mapping.");
        return;
      }
      if (Object.hasOwn(authorMapping, row.author.trim())) {
        setError(
          "Each author name can be matched only once. Remove the duplicate match.",
        );
        return;
      }
      authorMapping[row.author.trim()] = row.member || null;
    }
    const photoMapping: Record<string, string[]> = Object.create(null);
    for (const row of photoRows) {
      if (!row.id.trim() || !row.filenames) {
        setError("Enter an update ID and select a photo for each link.");
        return;
      }
      const id = row.id.trim();
      photoMapping[id] = [...(photoMapping[id] ?? []), row.filenames];
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
      <span className={styles.eyebrow}>Bring updates together</span>
      <h1>Import updates</h1>
      <ol className={styles.steps}>
        <li>Prepare your file</li>
        <li>Preview and check</li>
        <li>Confirm import</li>
      </ol>
      <p>
        Preview rows and author mappings before submitting. Possible duplicates
        are preserved for review.
      </p>
      <Card>
        <form onSubmit={previewImport} onChange={invalidate}>
          <div className={styles.importGrid}>
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
          </div>
          <h2>Match authors and photos</h2>
          <fieldset className={styles.mapping}>
            <legend>Link photos to updates</legend>
            <p>
              Match an update ID from your file to the filenames you selected
              above.
            </p>
            {photoRows.map((row, index) => (
              <div className={styles.mappingRow} key={row.rowId}>
                <label>
                  Update ID
                  <input
                    value={row.id}
                    onChange={(e) =>
                      setPhotoRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, id: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Photo
                  <select
                    value={row.filenames}
                    onChange={(e) =>
                      setPhotoRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, filenames: e.target.value } : r,
                        ),
                      )
                    }
                  >
                    <option value="">Select a photo</option>
                    {files.map((file) => (
                      <option key={file.name} value={file.name}>
                        {file.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setPhotoRows((rows) => rows.filter((_, i) => i !== index));
                    invalidate();
                  }}
                >
                  Remove photo link
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                invalidate();
                setPhotoRows((rows) => [
                  ...rows,
                  { rowId: key(), id: "", filenames: "" },
                ]);
              }}
            >
              Add photo link
            </button>
          </fieldset>
          <fieldset className={styles.mapping}>
            <legend>Match authors to volunteers</legend>
            <p>
              Optionally connect names in the file to members of your team.
              Leave a volunteer unknown when unsure.
            </p>
            {authorRows.map((row, index) => (
              <div className={styles.mappingRow} key={row.rowId}>
                <label>
                  Author name
                  <input
                    value={row.author}
                    onChange={(e) =>
                      setAuthorRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, author: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Volunteer
                  <select
                    value={row.member}
                    onChange={(e) =>
                      setAuthorRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, member: e.target.value } : r,
                        ),
                      )
                    }
                  >
                    <option value="">Unknown</option>
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setAuthorRows((rows) => rows.filter((_, i) => i !== index));
                    invalidate();
                  }}
                >
                  Remove author match
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                invalidate();
                setAuthorRows((rows) => [
                  ...rows,
                  { rowId: key(), author: "", member: "" },
                ]);
              }}
            >
              Add author match
            </button>
          </fieldset>
          <p>Default fields: id, author, text, timestamp.</p>
          <button type="submit" disabled={pending || reading}>
            Preview import
          </button>
        </form>
      </Card>
      <Live kind="alert">{error}</Live>
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
                  <li key={`${e.row}:${e.code}`}>
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
                  <li key={`${d.rows.join(",")}:${d.sourceIds.join(",")}`}>
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
      <span className={styles.eyebrow}>Reporting</span>
      <h1>Summary</h1>
      <p>Only approved contributions count toward recorded time.</p>
      <Card>
        <h2>Filter report</h2>
        <form className={styles.reportFilters} onSubmit={apply}>
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
      <Live kind="alert">{error}</Live>
      <Live kind="polite">{loading ? "Loading report…" : ""}</Live>
      {loading ? null : report && s ? (
        <>
          <div className={styles.sectionHeading}>
            <p>Timezone: {report.timezone}</p>
            <a href={`/api/product/reports.csv${query ? `?${query}` : ""}`}>
              Download aggregate CSV
            </a>
          </div>
          <div className={styles.metrics}>
            <Card>
              <h2>Approved hours</h2>
              <p className={styles.metricValue}>{report.approvedHours}</p>
              <p>Recorded time</p>
            </Card>
            <Card>
              <h2>Activities with approved contributions</h2>
              <p className={styles.metricValue}>
                {s.activitiesWithApprovedContributions}
              </p>
              <p>Activities in the ledger</p>
            </Card>
            <Card>
              <h2>Open needs</h2>
              <p className={styles.metricValue}>{report.openNeeds}</p>
              <p>{report.resolvedNeeds} resolved</p>
            </Card>
            <Card>
              <h2>Pending contributions</h2>
              <p className={styles.metricValue}>{s.pendingContributions}</p>
              <p>Awaiting complete information</p>
            </Card>
          </div>
          <Card>
            <div className={styles.sectionHeading}>
              <div>
                <span className={styles.eyebrow}>Report details</span>
                <h2>At a glance</h2>
              </div>
              <span>Approved ledger and needs</span>
            </div>
            <table className={styles.reportTable}>
              <tbody>
                <tr>
                  <th scope="row">Approved minutes</th>
                  <td>{s.approvedMinutes}</td>
                </tr>
                <tr>
                  <th scope="row">Approved contributions</th>
                  <td>{s.approvedContributions}</td>
                </tr>
                <tr>
                  <th scope="row">Pending with unknown duration</th>
                  <td>{s.pendingUnknownDuration}</td>
                </tr>
                <tr>
                  <th scope="row">Pending with unresolved volunteer</th>
                  <td>{s.pendingUnresolvedVolunteer}</td>
                </tr>
                <tr>
                  <th scope="row">Needs</th>
                  <td>
                    {report.openNeeds} open · {report.resolvedNeeds} resolved
                  </td>
                </tr>
                <tr>
                  <th scope="row">Average acknowledgment time</th>
                  <td>{duration(report.averageAcknowledgmentMinutes)}</td>
                </tr>
                <tr>
                  <th scope="row">Average resolution time</th>
                  <td>{duration(report.averageResolutionMinutes ?? null)}</td>
                </tr>
                <tr>
                  <th scope="row">Unknown dates excluded</th>
                  <td>{report.excludedUnknownDate}</td>
                </tr>
              </tbody>
            </table>
          </Card>
        </>
      ) : null}
    </>
  );
}
