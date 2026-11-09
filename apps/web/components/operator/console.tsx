"use client";

import type {
  OperatorCreateOrganizationResult,
  OperatorMemberRoleCommand,
  OperatorOrganizationDetail,
  OperatorOrganizationList,
} from "@relay/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errorMessage, request } from "../api-client";
import { Live } from "../card";
import { Button, Field, TextInput } from "../foundation";
import styles from "./console.module.css";

const api = <T,>(path: string, body?: Record<string, unknown>) =>
  request<T>(`/api/operator/${path}`, body);

function date(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown"
    : parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

function roleLabel(role: string) {
  return role === "report-reader"
    ? "Report reader"
    : role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Cross-organization console. It is not part of the workspace shell: nothing
 * here is tenant-scoped, and every refusal (including "this deployment has no
 * operators") renders the same unavailable state.
 */
export function OperatorConsole() {
  const [status, setStatus] = useState<"checking" | "unavailable" | "ready">(
    "checking",
  );
  const [list, setList] = useState<OperatorOrganizationList | null>(null);
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [detail, setDetail] = useState<OperatorOrganizationDetail | null>(null);
  const [detailId, setDetailId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Kept apart from the message so denial, rate limiting and an outage are not
  // all rendered as the same dead end.
  const [errorCode, setErrorCode] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState("");
  // The searched term, not the text in the box: a reload after a mutation must
  // not silently apply a search the operator has not submitted.
  const [submitted, setSubmitted] = useState("");
  // Detail responses can land out of order; only the newest one may render.
  const detailRequest = useRef(0);

  const load = useCallback(async (q: string, cursor: string | undefined) => {
    setBusy(true);
    setError("");
    setErrorCode("");
    const parameters = new URLSearchParams();
    if (q.trim().length >= 2) parameters.set("q", q.trim());
    if (cursor) parameters.set("cursor", cursor);
    const suffix = parameters.toString();
    const result = await api<OperatorOrganizationList>(
      `organizations${suffix ? `?${suffix}` : ""}`,
    );
    setBusy(false);
    if (result.ok) {
      setList(result.value);
      return;
    }
    setErrorCode(result.error.code);
    setError(errorMessage(result.error.code));
    // Losing operator authority (or having it revoked mid-session) must not
    // leave cross-organization data on screen.
    if (result.error.code === "NOT_FOUND") {
      setList(null);
      setDetail(null);
      setDetailId("");
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => {
    let live = true;
    void api<{ operator: true }>("session").then((result) => {
      if (!live) return;
      if (!result.ok) {
        // NOT_FOUND is a definitive "not an operator here"; anything else is
        // reported as a temporary problem instead of a permanent refusal.
        setErrorCode(result.error.code);
        setError(
          result.error.code === "NOT_FOUND"
            ? ""
            : errorMessage(result.error.code),
        );
        setStatus("unavailable");
        return;
      }
      setStatus("ready");
      void load("", undefined);
    });
    return () => {
      live = false;
    };
  }, [load]);

  async function review(organizationId: string) {
    const ticket = ++detailRequest.current;
    setDetailId(organizationId);
    setDetail(null);
    setError("");
    setErrorCode("");
    const result = await api<OperatorOrganizationDetail>(
      `organization?organizationId=${encodeURIComponent(organizationId)}`,
    );
    // A slower earlier response must never render under another organization.
    if (ticket !== detailRequest.current) return;
    if (result.ok) {
      if (result.value.organization.organizationId !== organizationId) {
        setErrorCode("CONFLICT");
        setError(errorMessage("CONFLICT"));
        return;
      }
      setDetail(result.value);
      return;
    }
    setErrorCode(result.error.code);
    setError(errorMessage(result.error.code));
  }

  async function changeRole(command: OperatorMemberRoleCommand) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<Record<string, never>>("member-role", {
      organizationId: command.organizationId,
      membershipId: command.membershipId,
      role: command.role,
      expectedRole: command.expectedRole,
    });
    setBusy(false);
    setConfirming("");
    if (!result.ok) {
      setErrorCode(result.error.code);
      setError(errorMessage(result.error.code));
      return;
    }
    setErrorCode("");
    setNotice(
      command.role === "owner"
        ? "Ownership granted. The organization’s history records the change."
        : "Ownership revoked. The organization’s history records the change.",
    );
    await load(submitted, cursors.at(-1));
    if (detailId === command.organizationId)
      await review(command.organizationId);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<OperatorCreateOrganizationResult>(
      "organizations",
      {
        name: String(form.get("name") ?? ""),
        slug: String(form.get("slug") ?? ""),
        timezone: String(form.get("timezone") ?? ""),
        ownerEmail: String(form.get("ownerEmail") ?? ""),
      },
    );
    setBusy(false);
    if (!result.ok) {
      setErrorCode(result.error.code);
      setError(
        result.error.code === "VALIDATION"
          ? "Check the details. The owner address must belong to a verified account with a password."
          : errorMessage(result.error.code),
      );
      return;
    }
    setErrorCode("");
    element.reset();
    setNotice(
      "Organization created with its first owner. The owner can sign in and open the workspace.",
    );
    setCursors([]);
    await load("", undefined);
  }

  if (status === "checking")
    return (
      <main className={styles.page} id="operator-main">
        <p>Checking access…</p>
      </main>
    );
  if (status === "unavailable")
    return (
      <main className={styles.page} id="operator-main">
        <section className={styles.panel}>
          <h1>Organization console</h1>
          <p>This page is not available.</p>
          <p>
            <a href="/workspace">Go to your workspace</a>
          </p>
        </section>
      </main>
    );

  return (
    <main className={styles.page} id="operator-main">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>PLATFORM</p>
          <h1>Organizations</h1>
          <p className={styles.intro}>
            Every organization on this deployment, with the people who own it.
            Your account is configured as an operator by the deployment, not by
            any organization.
          </p>
        </div>
        <p className={styles.headerLinks}>
          <a href="/workspace">Workspace</a>
        </p>
      </header>

      <Live kind="alert" className={styles.error}>
        {error ? (
          <>
            <p>{error}</p>
            {errorCode === "FORBIDDEN" ? (
              <p>
                <a href="/sign-in">Sign in again</a> to continue with a recent
                session.
              </p>
            ) : null}
            {errorCode === "DEPENDENCY_UNAVAILABLE" ||
            errorCode === "RATE_LIMITED" ? (
              <p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void load(submitted, cursors.at(-1))}
                >
                  Try again
                </Button>
              </p>
            ) : null}
          </>
        ) : null}
      </Live>
      <Live kind="status" className={styles.notice}>
        {notice}
      </Live>

      <form
        className={styles.search}
        aria-label="Search organizations"
        onSubmit={(event) => {
          event.preventDefault();
          setCursors([]);
          setSubmitted(query);
          void load(query, undefined);
        }}
      >
        <Field
          id="operator-query"
          label="Search organizations"
          hint="Matches the organization name or slug, not people."
        >
          <TextInput
            id="operator-query"
            name="q"
            value={query}
            maxLength={100}
            onChange={(event) => setQuery(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="secondary" disabled={busy}>
          Search
        </Button>
      </form>

      <section className={styles.panel} aria-labelledby="operator-create">
        <h2 id="operator-create">Create an organization</h2>
        <p>
          The first owner must already have a verified account with a password.
          Initial settings use the default review policy; the new owner can
          change them afterwards.
        </p>
        <form className={styles.createForm} onSubmit={create} noValidate>
          <Field id="operator-name" label="Name" required>
            <TextInput
              id="operator-name"
              name="name"
              maxLength={200}
              required
            />
          </Field>
          <Field
            id="operator-slug"
            label="Slug"
            hint="Lowercase letters and digits separated by single hyphens."
            required
          >
            <TextInput
              id="operator-slug"
              name="slug"
              maxLength={63}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              required
            />
          </Field>
          <Field
            id="operator-timezone"
            label="Timezone"
            hint="IANA name, for example America/New_York."
            required
          >
            <TextInput
              id="operator-timezone"
              name="timezone"
              maxLength={100}
              required
            />
          </Field>
          <Field id="operator-owner" label="First owner email" required>
            <TextInput
              id="operator-owner"
              name="ownerEmail"
              type="email"
              maxLength={254}
              autoComplete="off"
              required
            />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? "Working…" : "Create organization"}
          </Button>
        </form>
      </section>

      {list === null ? (
        <p aria-busy={busy}>{busy ? "Loading organizations…" : ""}</p>
      ) : list.organizations.length === 0 ? (
        <p>No organization matches that search.</p>
      ) : (
        <ul className={styles.list}>
          {list.organizations.map((organization) => (
            <li key={organization.organizationId} className={styles.item}>
              <section
                className={styles.card}
                aria-labelledby={`org-${organization.organizationId}`}
              >
                <div className={styles.cardHeading}>
                  <div>
                    <h2 id={`org-${organization.organizationId}`}>
                      {organization.name}
                    </h2>
                    <p className={styles.meta}>
                      {organization.slug} · created{" "}
                      {date(organization.createdAt)}
                    </p>
                  </div>
                  <p className={styles.counts}>
                    {organization.members.owner} owner
                    {organization.members.owner === 1 ? "" : "s"} ·{" "}
                    {organization.members.total} member
                    {organization.members.total === 1 ? "" : "s"}
                    {organization.pendingInvitations > 0
                      ? ` · ${organization.pendingInvitations} pending invitation${organization.pendingInvitations === 1 ? "" : "s"}`
                      : ""}
                  </p>
                </div>
                {organization.owners.length > 0 ? (
                  <ul className={styles.owners}>
                    {organization.owners.map((owner) => (
                      <li key={owner.membershipId}>
                        <span>{owner.name}</span>
                        <span className={styles.muted}>
                          {owner.maskedEmail}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.warning}>
                    This organization has no owner. Grant ownership to restore
                    administration.
                  </p>
                )}
                {organization.ownersTruncated ? (
                  <p className={styles.muted}>
                    Showing the first owners only. Open the organization to see
                    the full member list.
                  </p>
                ) : null}
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    aria-expanded={detailId === organization.organizationId}
                    onClick={() => {
                      if (detailId === organization.organizationId) {
                        setDetailId("");
                        setDetail(null);
                        return;
                      }
                      void review(organization.organizationId);
                    }}
                  >
                    {detailId === organization.organizationId
                      ? "Hide members"
                      : "Manage owners"}
                  </Button>
                </div>
                {detailId === organization.organizationId ? (
                  detail?.organization.organizationId !==
                  organization.organizationId ? (
                    <p aria-busy="true">Loading members…</p>
                  ) : (
                    <div className={styles.members}>
                      <h3>Members</h3>
                      <table className={styles.table}>
                        <caption className={styles.muted}>
                          Ownership changes are recorded in the organization’s
                          history. The last owner cannot be revoked.
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Person</th>
                            <th scope="col">Role</th>
                            <th scope="col">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.members.map((member) => {
                            const lastOwner =
                              member.role === "owner" &&
                              detail.organization.members.owner <= 1;
                            return (
                              <tr key={member.membershipId}>
                                <td>
                                  <span>{member.name}</span>{" "}
                                  <span className={styles.muted}>
                                    {member.maskedEmail}
                                  </span>
                                </td>
                                <td>{roleLabel(member.role)}</td>
                                <td>
                                  {member.role === "owner" ? (
                                    confirming === member.membershipId ? (
                                      <span className={styles.confirm}>
                                        <Button
                                          variant="danger"
                                          disabled={busy || lastOwner}
                                          onClick={() =>
                                            void changeRole({
                                              organizationId:
                                                detail.organization
                                                  .organizationId,
                                              membershipId: member.membershipId,
                                              role: "coordinator",
                                              expectedRole: member.role,
                                            })
                                          }
                                        >
                                          Confirm
                                        </Button>
                                        <Button
                                          variant="ghost"
                                          onClick={() => setConfirming("")}
                                        >
                                          Cancel
                                        </Button>
                                      </span>
                                    ) : (
                                      <Button
                                        variant="secondary"
                                        disabled={busy || lastOwner}
                                        onClick={() =>
                                          setConfirming(member.membershipId)
                                        }
                                      >
                                        Revoke to coordinator
                                      </Button>
                                    )
                                  ) : confirming === member.membershipId ? (
                                    <span className={styles.confirm}>
                                      <Button
                                        disabled={busy}
                                        onClick={() =>
                                          void changeRole({
                                            organizationId:
                                              detail.organization
                                                .organizationId,
                                            membershipId: member.membershipId,
                                            role: "owner",
                                            expectedRole: member.role,
                                          })
                                        }
                                      >
                                        Confirm
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        onClick={() => setConfirming("")}
                                      >
                                        Cancel
                                      </Button>
                                    </span>
                                  ) : (
                                    <Button
                                      variant="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        setConfirming(member.membershipId)
                                      }
                                    >
                                      Make owner
                                    </Button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {detail.membersTruncated ? (
                        <p className={styles.muted}>
                          This organization has more members than one page
                          shows. Only the first {detail.members.length} are
                          listed, so a person outside that list cannot be made
                          an owner here.
                        </p>
                      ) : null}
                    </div>
                  )
                ) : null}
              </section>
            </li>
          ))}
        </ul>
      )}

      {list && (cursors.length > 0 || list.nextCursor) ? (
        <nav className={styles.pager} aria-label="Organization pages">
          <Button
            variant="secondary"
            disabled={busy || cursors.length === 0}
            onClick={() => {
              const previous = [...cursors];
              previous.pop();
              setCursors(previous);
              void load(submitted, previous.at(-1));
            }}
          >
            Previous page
          </Button>
          <Button
            variant="secondary"
            disabled={busy || list.nextCursor === null}
            onClick={() => {
              if (!list.nextCursor) return;
              setCursors([...cursors, list.nextCursor]);
              void load(submitted, list.nextCursor);
            }}
          >
            Next page
          </Button>
        </nav>
      ) : null}
    </main>
  );
}
