"use client";
import {
  type ContractRole,
  type OrganizationSettings,
  type ProductNotification,
  updateOrganizationSettingsSchema,
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
import { type ApiResult, errorMessage, request } from "../api-client";
import { Card, Live } from "../card";
import styles from "./admin.module.css";

type Result<T> = ApiResult<T>;
const api = <T,>(path: string, body?: object) =>
  request<T>(`/api/product/${path}`, body);
const message = errorMessage;
function useWrite() {
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function write<T>(
    path: string,
    body: object,
    idempotent: boolean,
  ): Promise<Result<T>> {
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([path, body]);
    if (!attempt.current || attempt.current.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    const current = attempt.current;
    const result = await api<T>(
      path,
      idempotent ? { ...body, idempotencyKey: current.key } : body,
    );
    if (result.ok) {
      attempt.current = null;
      setNotice("Saved.");
    } else setError(message(result.error.code));
    setBusy(false);
    return result;
  }
  return {
    write,
    error,
    busy,
    notice,
    change: () => {
      attempt.current = null;
    },
  };
}
function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <Card className={`${styles.card} ${className}`}>{children}</Card>;
}
function Status({ error, notice }: { error: string; notice?: string }) {
  return (
    <>
      <Live kind="alert" className={styles.error}>
        {error}
      </Live>
      <Live kind="status" className={styles.notice}>
        {notice}
      </Live>
    </>
  );
}
function useLoad<T>(path: string) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const result = await api<T>(path);
    if (result.ok) {
      setValue(result.value);
      setError("");
    } else {
      setValue(null);
      setError(message(result.error.code));
    }
    setLoading(false);
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { value, error, loading, reload, setValue };
}
export function Settings({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  const data = useLoad<OrganizationSettings>("settings");
  const owner = snapshot.organization.role === "owner";
  const [staff, setStaff] = useState<Member[] | null>(null);
  const [staffError, setStaffError] = useState("");
  const reloadStaff = useCallback(async () => {
    setStaff(null);
    setStaffError("");
    const result = await api<Member[]>("members");
    if (result.ok)
      setStaff(
        result.value.filter(
          (member) => member.role === "owner" || member.role === "coordinator",
        ),
      );
    else
      setStaffError(
        "Team members could not be loaded. Try again before changing routing.",
      );
  }, []);
  useEffect(() => {
    if (owner) void reloadStaff();
  }, [owner, reloadStaff]);
  return (
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>WORKSPACE ADMINISTRATION</p>
          <h1>Organization settings</h1>
          <p>Set how work is routed, reviewed and retained for your team.</p>
        </div>
        {data.value && (
          <span className={styles.revision}>
            Revision {data.value.revision}
          </span>
        )}
      </header>
      <Live kind="alert" className={styles.error}>
        {owner && staffError ? (
          <>
            <p>{staffError}</p>
            <button type="button" onClick={() => void reloadStaff()}>
              Retry team members
            </button>
          </>
        ) : (
          ""
        )}
      </Live>
      <Live kind="polite" className={styles.loading}>
        {data.loading ? "Loading settings…" : ""}
      </Live>
      {data.loading ? null : data.value ? (
        <SettingsForm
          key={data.value.revision}
          initial={data.value}
          owner={owner}
          members={owner ? (staff ?? []) : snapshot.members}
          membersReady={!owner || staff !== null}
          reload={data.reload}
        />
      ) : (
        <Panel>
          <Status error={data.error} />
          <button type="button" onClick={() => void data.reload()}>
            Try again
          </button>
        </Panel>
      )}
    </div>
  );
}
function SettingsForm({
  initial,
  owner,
  members,
  membersReady,
  reload,
}: {
  initial: OrganizationSettings;
  owner: boolean;
  members: WorkspaceSnapshot["members"];
  membersReady: boolean;
  reload: () => Promise<void>;
}) {
  const writer = useWrite();
  const [routing, setRouting] = useState(() =>
    Object.entries(initial.routing).map(([category, memberIds]) => ({
      key: crypto.randomUUID(),
      category,
      memberIds: [...memberIds],
    })),
  );
  const [fallback, setFallback] = useState(initial.fallbackMembershipId ?? "");
  const [localError, setLocalError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (!membersReady) return;
    if (
      fallback &&
      !members.some((member) => member.membershipId === fallback)
    ) {
      setLocalError(
        "Choose an available fallback member or explicitly select No fallback member.",
      );
      return;
    }
    const routes: Record<string, string[]> = Object.create(null);
    for (const row of routing) {
      const category = row.category.trim();
      if (["__proto__", "constructor", "prototype"].includes(category)) {
        setLocalError(
          "Choose a different category name; this name is reserved.",
        );
        return;
      }
      if (!category || Object.hasOwn(routes, category)) {
        setLocalError("Give each route a different, nonempty category.");
        return;
      }
      if (
        row.memberIds.some(
          (id) => !members.some((member) => member.membershipId === id),
        )
      ) {
        setLocalError(
          "Remove unavailable team members from routing before saving.",
        );
        return;
      }
      routes[category] = [...new Set(row.memberIds)];
    }
    const draft = {
      expectedRevision: initial.revision,
      idempotencyKey: "placeholder",
      timezone: String(f.get("timezone")),
      automationPolicy: String(f.get("policy")),
      policyVersion: String(f.get("version")),
      routing: routes,
      fallbackMembershipId: String(f.get("fallback") || "") || null,
      ackMinutes: Number(f.get("ack")),
      retentionDays: Number(f.get("retention")),
    };
    const parsed = updateOrganizationSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setLocalError("Check the timezone, routing and settings fields.");
      return;
    }
    setLocalError("");
    const { idempotencyKey: _key, ...body } = parsed.data;
    if ((await writer.write("settings", body, true)).ok) await reload();
  }
  return (
    <>
      {!owner && (
        <p className={styles.permissionNote}>
          You can review these settings. Only an organization owner can change
          them.
        </p>
      )}
      <Panel className={styles.settingsPanel}>
        <form
          onSubmit={save}
          onChange={writer.change}
          className={styles.settingsForm}
        >
          <fieldset disabled={!owner || writer.busy || !membersReady}>
            <section
              className={styles.settingsSection}
              aria-labelledby="routing-title"
            >
              <div className={styles.sectionIntro}>
                <h2 id="routing-title">Routing and review</h2>
                <p>
                  Choose the review policy and the team members who receive each
                  type of need.
                </p>
              </div>
              <div className={styles.formGrid}>
                <label>
                  Automation policy
                  <select name="policy" defaultValue={initial.automationPolicy}>
                    <option value="review-all">Review all</option>
                    <option value="validated-auto-record">
                      Validated auto-record
                    </option>
                  </select>
                  <span className={styles.help}>
                    Auto-record applies only when server eligibility checks
                    pass. All other proposals wait for staff review.
                  </span>
                </label>
                <label>
                  Policy version
                  <input
                    name="version"
                    defaultValue={initial.policyVersion}
                    required
                    maxLength={100}
                  />
                  <span className={styles.help}>
                    A short reference used to identify the active review rules.
                  </span>
                </label>
                <section
                  className={`${styles.spanTwo} ${styles.routingRules}`}
                  aria-labelledby="routing-rules-title"
                >
                  <h3 id="routing-rules-title">Category routes</h3>
                  <p className={styles.help}>
                    Choose the people responsible for each category. Only owners
                    and coordinators can receive routed needs.
                  </p>
                  <Live kind="polite">
                    {owner && !membersReady ? "Loading team members…" : ""}
                  </Live>
                  {routing.length === 0 && (
                    <p>
                      No category routes yet. Unmatched needs use the fallback
                      below.
                    </p>
                  )}
                  {routing.map((row, index) => (
                    <fieldset className={styles.routingRule} key={row.key}>
                      <legend>Route {index + 1}</legend>
                      <label>
                        Category
                        <input
                          value={row.category}
                          maxLength={100}
                          required
                          placeholder="For example, transport"
                          onChange={(event) =>
                            setRouting((rows) =>
                              rows.map((item) =>
                                item.key === row.key
                                  ? { ...item, category: event.target.value }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                      <div className={styles.routingRecipients}>
                        {members.map((member) => (
                          <label key={member.membershipId}>
                            <input
                              type="checkbox"
                              checked={row.memberIds.includes(
                                member.membershipId,
                              )}
                              onChange={(event) =>
                                setRouting((rows) =>
                                  rows.map((item) =>
                                    item.key === row.key
                                      ? {
                                          ...item,
                                          memberIds: event.target.checked
                                            ? [
                                                ...new Set([
                                                  ...item.memberIds,
                                                  member.membershipId,
                                                ]),
                                              ]
                                            : item.memberIds.filter(
                                                (id) =>
                                                  id !== member.membershipId,
                                              ),
                                        }
                                      : item,
                                  ),
                                )
                              }
                            />
                            {member.name}
                          </label>
                        ))}
                        {row.memberIds
                          .filter(
                            (id) =>
                              !members.some(
                                (member) => member.membershipId === id,
                              ),
                          )
                          .map((id) => (
                            <div key={id} className={styles.help}>
                              Unavailable team member
                              <button
                                type="button"
                                onClick={() => {
                                  writer.change();
                                  setRouting((rows) =>
                                    rows.map((item) =>
                                      item.key === row.key
                                        ? {
                                            ...item,
                                            memberIds: item.memberIds.filter(
                                              (value) => value !== id,
                                            ),
                                          }
                                        : item,
                                    ),
                                  );
                                }}
                              >
                                Remove unavailable member
                              </button>
                            </div>
                          ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          writer.change();
                          setRouting((rows) =>
                            rows.filter((item) => item.key !== row.key),
                          );
                        }}
                      >
                        Remove route
                      </button>
                    </fieldset>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      writer.change();
                      setRouting((rows) => [
                        ...rows,
                        {
                          key: crypto.randomUUID(),
                          category: "",
                          memberIds: [],
                        },
                      ]);
                    }}
                  >
                    Add category route
                  </button>
                </section>
                <label>
                  Fallback member
                  <select
                    name="fallback"
                    value={fallback}
                    onChange={(event) => setFallback(event.target.value)}
                  >
                    <option value="">No fallback member</option>
                    {fallback &&
                      !members.some(
                        (member) => member.membershipId === fallback,
                      ) && (
                        <option value={fallback}>
                          Unavailable previous recipient — choose a replacement
                        </option>
                      )}
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <span className={styles.help}>
                    Used when a category has no matching route.
                  </span>
                </label>
                <label>
                  Acknowledgment deadline
                  <span className={styles.inputWithUnit}>
                    <input
                      name="ack"
                      type="number"
                      min="1"
                      max="10080"
                      defaultValue={initial.ackMinutes}
                      required
                    />
                    <span>minutes</span>
                  </span>
                  <span className={styles.help}>
                    Time allowed for a person to acknowledge an assigned need.
                  </span>
                </label>
              </div>
            </section>
            <section
              className={styles.settingsSection}
              aria-labelledby="org-title"
            >
              <div className={styles.sectionIntro}>
                <h2 id="org-title">Organization and privacy</h2>
                <p>
                  Keep dates consistent and set how long source evidence is
                  retained.
                </p>
              </div>
              <div className={styles.formGrid}>
                <label>
                  Organization timezone
                  <input
                    name="timezone"
                    defaultValue={initial.timezone}
                    required
                  />
                  <span className={styles.help}>
                    Use an IANA timezone such as America/Chicago.
                  </span>
                </label>
                <label>
                  Source retention
                  <span className={styles.inputWithUnit}>
                    <input
                      name="retention"
                      type="number"
                      min="1"
                      max="3650"
                      defaultValue={initial.retentionDays}
                      required
                    />
                    <span>days</span>
                  </span>
                  <span className={styles.help}>
                    Expired evidence becomes eligible for review; it is not
                    removed automatically from this screen.
                  </span>
                </label>
              </div>
            </section>
            {owner && (
              <div className={styles.formFooter}>
                <span>Saving creates a new settings revision.</span>
                <button type="submit" disabled={writer.busy}>
                  {writer.busy ? "Saving…" : "Save settings"}
                </button>
              </div>
            )}
          </fieldset>
        </form>
      </Panel>
      <Status error={localError || writer.error} notice={writer.notice} />
    </>
  );
}
export function Notifications() {
  const list = useLoad<ProductNotification[]>("notifications");
  const prefs = useLoad<{ email: boolean; telegram: boolean }>(
    "notification-preferences",
  );
  const writer = useWrite();
  const [copyMessage, setCopyMessage] = useState("");
  const [link, setLink] = useState<{
    token: string | null;
    expiresAt: string;
  } | null>(null);
  const expiry = useRef<string | null>(null);
  async function read(n: ProductNotification) {
    if (
      (
        await writer.write(
          "notification-read",
          { notificationId: n.id, expectedRevision: n.revision },
          true,
        )
      ).ok
    )
      await list.reload();
  }
  async function preferences(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = await writer.write(
      "notification-preferences",
      { email: f.get("email") === "on", telegram: f.get("telegram") === "on" },
      false,
    );
    if (result.ok) await prefs.reload();
  }
  async function linkTelegram() {
    expiry.current ??= new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const result = await writer.write<{
      linkId: string;
      token: string | null;
      expiresAt: string;
    }>("telegram-link", { expiresAt: expiry.current }, true);
    if (result.ok) {
      setLink(result.value);
      expiry.current = null;
      setCopyMessage("");
    }
  }
  return (
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>TEAM COMMUNICATION</p>
          <h1>Notifications</h1>
          <p>
            Keep up with assigned work and choose where team updates arrive.
          </p>
        </div>
      </header>
      <Status error={writer.error || list.error} notice={writer.notice} />
      <div className={styles.notificationGrid}>
        <Panel className={styles.inboxPanel}>
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.eyebrow}>ACTIVITY</p>
              <h2>Notification inbox</h2>
            </div>
            <span className={styles.count}>
              {list.loading
                ? "Loading"
                : list.error
                  ? "Unavailable"
                  : `${list.value?.filter((n) => !n.readAt).length ?? 0} unread`}
            </span>
          </div>
          <Live kind="polite" className={styles.loading}>
            {list.loading ? "Loading notifications…" : ""}
          </Live>
          {list.loading ? null : list.value?.length ? (
            <ul className={styles.notificationList}>
              {list.value.map((n) => (
                <li
                  className={`${styles.notification} ${n.readAt ? "" : styles.unread}`}
                  key={n.id}
                >
                  <span className={styles.notificationMark} aria-hidden="true">
                    {n.readAt ? "✓" : "•"}
                  </span>
                  <div className={styles.notificationBody}>
                    <strong>{n.title}</strong>
                    <span>{new Date(n.createdAt).toLocaleString()}</span>
                    <div className={styles.notificationActions}>
                      {/^\/(?![/\\])/.test(n.appPath) && (
                        <a href={n.appPath}>Open related work</a>
                      )}
                      {!n.readAt && (
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          disabled={writer.busy}
                          onClick={() => void read(n)}
                        >
                          Mark read
                        </button>
                      )}
                      {n.readAt && (
                        <span className={styles.readLabel}>Read</span>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : list.error ? (
            <button type="button" onClick={() => void list.reload()}>
              Try again
            </button>
          ) : (
            <p className={styles.empty}>
              You’re all caught up. New assignments and updates will appear
              here.
            </p>
          )}
        </Panel>
        <div className={styles.preferenceStack}>
          <Panel>
            <p className={styles.eyebrow}>DELIVERY CHANNELS</p>
            <h2>Delivery preferences</h2>
            <p className={styles.cardIntro}>
              Choose the channels where you want to receive organization
              notifications.
            </p>
            <Live kind="polite" className={styles.loading}>
              {prefs.loading ? "Loading preferences…" : ""}
            </Live>
            {prefs.loading ? null : prefs.value ? (
              <form
                className={styles.preferenceForm}
                key={`${prefs.value.email}-${prefs.value.telegram}`}
                onSubmit={preferences}
                onChange={writer.change}
              >
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    name="email"
                    defaultChecked={prefs.value.email}
                    aria-labelledby="email-channel-label"
                    aria-describedby="email-channel-description"
                  />
                  <span>
                    <strong id="email-channel-label">Email</strong>
                    <small id="email-channel-description">
                      Send updates to your organization email address.
                    </small>
                  </span>
                </label>
                <label className={styles.checkRow}>
                  <input
                    type="checkbox"
                    name="telegram"
                    defaultChecked={prefs.value.telegram}
                    aria-labelledby="telegram-channel-label"
                    aria-describedby="telegram-channel-description"
                  />
                  <span>
                    <strong id="telegram-channel-label">Telegram</strong>
                    <small id="telegram-channel-description">
                      Send updates to your linked Telegram account.
                    </small>
                  </span>
                </label>
                <button type="submit" disabled={writer.busy}>
                  {writer.busy ? "Saving…" : "Save preferences"}
                </button>
              </form>
            ) : (
              <>
                <Status error={prefs.error} />
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={() => void prefs.reload()}
                >
                  Try loading preferences again
                </button>
              </>
            )}
          </Panel>
          <Panel>
            <p className={styles.eyebrow}>ACCOUNT LINK</p>
            <h2>Telegram</h2>
            <p className={styles.cardIntro}>
              Link your account through the official bot. The one-time
              instruction expires after ten minutes.
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={writer.busy}
                onClick={() => void linkTelegram()}
              >
                Create link instruction
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                disabled={writer.busy}
                onClick={async () => {
                  if ((await writer.write("telegram-unlink", {}, false)).ok) {
                    setLink(null);
                    setCopyMessage("");
                  }
                }}
              >
                Unlink Telegram
              </button>
            </div>
            {link &&
              (link.token ? (
                <div className={styles.linkInstruction}>
                  <label htmlFor="telegram-instruction">
                    One-time instruction
                  </label>
                  <div className={styles.copyRow}>
                    <input
                      id="telegram-instruction"
                      readOnly
                      value={`/link ${link.token}`}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            `/link ${link.token}`,
                          );
                          setCopyMessage("Instruction copied.");
                        } catch {
                          setCopyMessage(
                            "Select and copy the instruction above.",
                          );
                        }
                      }}
                    >
                      Copy
                    </button>
                  </div>
                  <Live kind="polite">{copyMessage}</Live>
                  <p>Expires {new Date(link.expiresAt).toLocaleString()}</p>
                </div>
              ) : (
                <p className={styles.help}>
                  A token is unavailable for this request. Create a new link
                  instruction.
                </p>
              ))}
          </Panel>
        </div>
      </div>
    </div>
  );
}
type Member = {
  membershipId: string;
  name: string;
  email: string;
  role: ContractRole;
};
const roleName: Record<ContractRole, string> = {
  owner: "Owner",
  coordinator: "Coordinator",
  "report-reader": "Report reader",
  volunteer: "Volunteer",
};
export function Members() {
  const list = useLoad<Member[]>("members");
  const writer = useWrite();
  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (
      (
        await writer.write(
          "members/invite",
          { email: String(f.get("email")), role: String(f.get("role")) },
          false,
        )
      ).ok
    ) {
      form.reset();
      await list.reload();
    }
  }
  async function role(e: FormEvent<HTMLFormElement>, member: Member) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (
      (
        await writer.write(
          "members/role",
          { membershipId: member.membershipId, role: String(f.get("role")) },
          false,
        )
      ).ok
    )
      await list.reload();
  }
  return (
    <div className={styles.page}>
      <header className={styles.pageHeading}>
        <div>
          <p className={styles.eyebrow}>WORKSPACE ADMINISTRATION</p>
          <h1>Members</h1>
          <p>
            Invite your team and keep access matched to each person’s
            responsibilities.
          </p>
        </div>
        {list.value && (
          <span className={styles.revision}>{list.value.length} members</span>
        )}
      </header>
      <Status error={writer.error || list.error} notice={writer.notice} />
      <Panel className={styles.invitePanel}>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.eyebrow}>GROW YOUR TEAM</p>
            <h2>Invite a member</h2>
          </div>
        </div>
        <p className={styles.cardIntro}>
          Send an invitation by email and choose the access they need to get
          started.
        </p>
        <form
          onSubmit={invite}
          onChange={writer.change}
          className={styles.inviteForm}
        >
          <label>
            Email address
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="name@example.org"
              required
            />
          </label>
          <label>
            Workspace role
            <select name="role" defaultValue="volunteer">
              <Roles />
            </select>
          </label>
          <button type="submit" disabled={writer.busy}>
            {writer.busy ? "Sending…" : "Send invitation"}
          </button>
        </form>
      </Panel>
      <Panel>
        <div className={styles.panelHeading}>
          <div>
            <p className={styles.eyebrow}>ACCESS ROSTER</p>
            <h2>Current members</h2>
          </div>
        </div>
        <Live kind="polite" className={styles.loading}>
          {list.loading ? "Loading members…" : ""}
        </Live>
        {list.loading ? null : list.value?.length ? (
          <div className={styles.roster}>
            {list.value.map((m) => (
              <article className={styles.memberRow} key={m.membershipId}>
                <div className={styles.memberIdentity}>
                  <span className={styles.memberAvatar} aria-hidden="true">
                    {m.name
                      .trim()
                      .split(/\s+/)
                      .slice(0, 2)
                      .map((s) => s[0])
                      .join("")
                      .toUpperCase()}
                  </span>
                  <div>
                    <strong>{m.name}</strong>
                    <span>{m.email}</span>
                  </div>
                </div>
                <span
                  className={`${styles.roleBadge} ${styles[`role_${m.role.replace("-", "_")}`]}`}
                >
                  {roleName[m.role]}
                </span>
                <form
                  className={styles.memberActions}
                  onSubmit={(e) => void role(e, m)}
                  onChange={writer.change}
                >
                  <label
                    className={styles.visuallyHidden}
                    htmlFor={`member-role-${m.membershipId}`}
                  >
                    Role for {m.name}
                  </label>
                  <select
                    id={`member-role-${m.membershipId}`}
                    name="role"
                    defaultValue={m.role}
                  >
                    <Roles />
                  </select>
                  <button
                    type="submit"
                    className={styles.secondaryButton}
                    disabled={writer.busy}
                  >
                    Update role
                  </button>
                  <button
                    type="button"
                    className={styles.removeButton}
                    disabled={writer.busy}
                    onClick={async () => {
                      if (
                        (
                          await writer.write(
                            "members/remove",
                            { membershipId: m.membershipId },
                            false,
                          )
                        ).ok
                      )
                        await list.reload();
                    }}
                  >
                    Remove
                  </button>
                </form>
              </article>
            ))}
          </div>
        ) : list.error ? (
          <button type="button" onClick={() => void list.reload()}>
            Try again
          </button>
        ) : (
          <p className={styles.empty}>
            No members found. Invite someone to begin working together.
          </p>
        )}
        <p className={styles.rosterNote}>
          Role changes and removals take effect across this workspace.
        </p>
      </Panel>
    </div>
  );
}
function Roles() {
  return (
    <>
      <option value="volunteer">Volunteer</option>
      <option value="coordinator">Coordinator</option>
      <option value="report-reader">Report reader</option>
      <option value="owner">Owner</option>
    </>
  );
}
