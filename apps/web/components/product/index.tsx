"use client";

import {
  type AuthPendingInvitation,
  productEndpoints,
  type WorkspaceSnapshot,
} from "@relay/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
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
import {
  loadOrganizations,
  loadPendingInvitations,
  mutateAuth,
} from "../auth/transport";
import { Live } from "../card";
import { Button, Icon, type IconName, Select, Skeleton } from "../foundation";
import { StaffShell, VolunteerShell } from "../layout";
import { splitOrganizationHint } from "../org-hint";
import { Members, Notifications, Settings } from "./admin";
import { Import } from "./import";
import { Inbox } from "./inbox";
import { Activities } from "./ledger";
import { Needs } from "./needs";
import { Delivery, History } from "./operations";
import { Overview } from "./overview";
import styles from "./product.module.css";
import { Retention } from "./retention";
import { date, key } from "./shared";
import { Summary } from "./summary";
import { Volunteer } from "./volunteer";

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
function StatePanel({
  icon,
  tone = "neutral",
  title,
  children,
  actions,
}: {
  icon: IconName;
  tone?: "neutral" | "danger" | "accent";
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={styles.state}>
      <span
        className={`${styles.stateIcon} ${styles[tone]}`}
        aria-hidden="true"
      >
        <Icon name={icon} size={24} />
      </span>
      <h1>{title}</h1>
      {children}
      {actions && <div className={styles.stateActions}>{actions}</div>}
    </section>
  );
}
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
    <div className={styles.orgSwitch}>
      <label htmlFor="organization">Organization</label>
      <Select
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
      </Select>
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
      <StatePanel icon="members" tone="accent" title="Choose an organization">
        <form
          className={styles.orgForm}
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
          <fieldset className={styles.orgList} disabled={pending}>
            <legend>Select an organization to open its workspace.</legend>
            {options.map((option) => (
              <label key={option.organizationId} className={styles.orgChoice}>
                <input
                  type="radio"
                  name="organizationId"
                  value={option.organizationId}
                  checked={chosen === option.organizationId}
                  onChange={() => setChosen(option.organizationId)}
                />
                <span>
                  {option.name} ({option.role})
                </span>
              </label>
            ))}
          </fieldset>
          <Live kind="alert">{error}</Live>
          <Button type="submit" disabled={pending || !chosen}>
            {pending ? "Opening…" : "Open workspace"}
          </Button>
        </form>
      </StatePanel>
    </main>
  );
}
const invitationRole: Record<AuthPendingInvitation["role"], string> = {
  owner: "Owner",
  coordinator: "Coordinator",
  volunteer: "Volunteer",
  "report-reader": "Report reader",
};
// One neutral message for every refusal: it never says whether the invitation
// exists, was withdrawn, expired or belongs to someone else.
const invitationAcceptFailed =
  "This invitation could not be accepted. It may have expired or been withdrawn. Open the link in your invitation email, or ask for a new invitation.";
const invitationsUnavailable =
  "Invitations could not be loaded right now. You can still open the link in your invitation email.";
function NoOrganization() {
  const [error, setError] = useState("");
  const [invitations, setInvitations] = useState<Awaited<
    ReturnType<typeof loadPendingInvitations>
  > | null>(null);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState("");
  // Shared across StrictMode's double effect run so the list loads only once.
  const loadOnce = useRef<ReturnType<typeof loadPendingInvitations> | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    loadOnce.current ??= loadPendingInvitations();
    void loadOnce.current.then((result) => {
      if (live) setInvitations(result);
    });
    return () => {
      live = false;
    };
  }, []);
  const listed =
    invitations?.ok && invitations.value.emailVerified
      ? invitations.value.invitations
      : [];
  const unverified =
    invitations?.ok === true && !invitations.value.emailVerified;
  return (
    <main className={styles.standalone}>
      <StatePanel
        icon="members"
        tone="accent"
        title="You're not in an organization yet"
        actions={
          <Button
            variant="secondary"
            onClick={async () => {
              setError("");
              const result = await mutateAuth("sign-out", {});
              if (result.ok) window.location.assign("/sign-in");
              else setError(errorMessage(result.error.code));
            }}
          >
            Sign out
          </Button>
        }
      >
        <Live kind="polite">
          {invitations === null ? "Loading invitations…" : ""}
        </Live>
        {listed.length > 0 ? (
          <section
            className={styles.invites}
            aria-labelledby="pending-invitations"
          >
            <h2 id="pending-invitations">Invitations waiting for you</h2>
            <p>Accept an invitation to join that organization.</p>
            <ul className={styles.inviteList} aria-busy={accepting !== null}>
              {listed.map((item) => (
                <li key={item.invitationId} className={styles.invite}>
                  <h3>{item.organizationName}</h3>
                  <p>Role: {invitationRole[item.role]}</p>
                  <p>
                    Expires{" "}
                    <time dateTime={item.expiresAt}>
                      {date(item.expiresAt)}
                    </time>
                  </p>
                  <Button
                    disabled={accepting !== null}
                    aria-label={`Accept invitation to ${item.organizationName}`}
                    onClick={async () => {
                      if (accepting !== null) return;
                      setAccepting(item.invitationId);
                      setAcceptError("");
                      const result = await mutateAuth("invitations/accept", {
                        invitationId: item.invitationId,
                      });
                      if (result.ok) {
                        window.location.assign("/workspace");
                        return;
                      }
                      setAcceptError(invitationAcceptFailed);
                      setAccepting(null);
                    }}
                  >
                    {accepting === item.invitationId ? "Accepting…" : "Accept"}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <Live kind="alert">
          {acceptError ||
            (invitations !== null && !invitations.ok
              ? invitationsUnavailable
              : "")}
        </Live>
        {unverified ? (
          <p>
            Your email address is not verified yet.{" "}
            <a href="/verify-email">Verify your email</a> to see invitations
            sent to it here.
          </p>
        ) : null}
        {listed.length === 0 ? (
          <p>
            An owner or coordinator needs to invite you. Check your email for an
            invitation, and make sure your email address is{" "}
            <a href="/verify-email">verified</a>. Then open the invitation link
            to join.
          </p>
        ) : null}
        <Live kind="alert">{error}</Live>
      </StatePanel>
    </main>
  );
}
const pages = new Set<string>([
  "volunteer",
  "inbox",
  "activities",
  "needs",
  "reports",
  "import",
  "settings",
  "members",
  "notifications",
  "history",
  "delivery",
  "retention",
]);
// One workspace instance lives in app/workspace/layout.tsx, so moving between
// pages is a client navigation that keeps the loaded snapshot instead of
// remounting, refetching and flashing a loading screen.
function pageFromPath(pathname: string): Page {
  const segment = pathname.replace(/\/+$/, "").split("/")[2] ?? "";
  return pages.has(segment) ? (segment as Page) : "home";
}
export function ProductWorkspace({ page: pageProp }: { page?: Page }) {
  const pathname = usePathname();
  const page = pageProp ?? pageFromPath(pathname);
  const firstPage = useRef(true);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [orgOptions, setOrgOptions] = useState<readonly OrgOption[] | null>(
    null,
  );
  const [noOrganization, setNoOrganization] = useState(false);
  const [workspaceChanged, setWorkspaceChanged] = useState(false);
  const hintResolved = useRef(false);
  useEffect(() => onWorkspaceChanged(() => setWorkspaceChanged(true)), []);
  useEffect(() => {
    // Full page loads used to reset focus and per-page request attempts; a
    // client navigation must do both explicitly.
    void page;
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    attempts.current = {};
    document.getElementById("workspace-main")?.focus({ preventScroll: true });
  }, [page]);
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
        <div className={styles.loading}>
          <Skeleton width={48} height={48} />
          <p>Loading workspace…</p>
          <Skeleton width="100%" height={16} />
          <Skeleton width="70%" height={16} />
        </div>
      </main>
    );
  if (!snapshot && orgOptions)
    return <OrganizationPicker options={orgOptions} />;
  if (!snapshot && noOrganization) return <NoOrganization />;
  if (!snapshot)
    return (
      <main className={styles.standalone}>
        <StatePanel
          icon="alert"
          tone="danger"
          title="Workspace unavailable"
          actions={
            <>
              {errorCode === "FORBIDDEN" ? (
                <a className={styles.linkButton} href="/account">
                  Choose an organization or sign out
                </a>
              ) : (
                <a className={styles.linkButton} href="/sign-in">
                  Sign in
                </a>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  setLoading(true);
                  void refresh();
                }}
              >
                Try again
              </Button>
            </>
          }
        >
          <p role="alert">{error}</p>
        </StatePanel>
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
      className={styles.page}
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
        <StatePanel
          icon="flag"
          tone="accent"
          title="Permission denied"
          actions={
            <Link className={styles.linkButton} href="/workspace">
              Go to your workspace
            </Link>
          }
        >
          <p>Your role does not have access to this page.</p>
        </StatePanel>
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
          <Link href="/workspace/volunteer">My updates</Link>
          {" · "}
          <Link href="/workspace/notifications">Notifications</Link>
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
