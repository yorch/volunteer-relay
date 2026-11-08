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
import { Button, Field, Icon, Select, TextInput } from "../foundation";
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
const describedBy = (id: string, hint?: boolean, error?: string) =>
  [hint ? `${id}-hint` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ") || undefined;
const wholeNumber = (
  value: string,
  label: string,
  min: number,
  max: number,
) => {
  const text = value.trim();
  if (!text) return `Enter the ${label}.`;
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max
    ? ""
    : `Enter a whole number from ${min} to ${max}.`;
};
const timezoneError = (value: string) => {
  if (!value.trim()) return "Enter an organization timezone.";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() });
    return "";
  } catch {
    return "Use an IANA timezone such as America/Chicago.";
  }
};
const fieldCheck: Record<string, (value: string) => string> = {
  "policy-version": (v) => (v.trim() ? "" : "Enter a policy version."),
  "ack-minutes": (v) => wholeNumber(v, "acknowledgment deadline", 1, 10080),
  "org-timezone": timezoneError,
  "source-retention": (v) => wholeNumber(v, "retention period", 1, 3650),
};
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
            <Button variant="secondary" onClick={() => void reloadStaff()}>
              Retry team members
            </Button>
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
          <Button variant="secondary" onClick={() => void data.reload()}>
            Try again
          </Button>
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
  const [policy, setPolicy] = useState<string>(initial.automationPolicy);
  const [localError, setLocalError] = useState("");
  const [values, setValues] = useState<Record<string, string>>({
    "policy-version": initial.policyVersion,
    "ack-minutes": String(initial.ackMinutes),
    "org-timezone": initial.timezone,
    "source-retention": String(initial.retentionDays),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [routeErrors, setRouteErrors] = useState<Record<string, string>>({});
  const [baseline] = useState(() =>
    JSON.stringify([
      initial.policyVersion,
      String(initial.ackMinutes),
      initial.timezone,
      String(initial.retentionDays),
      initial.automationPolicy,
      initial.fallbackMembershipId ?? "",
      Object.entries(initial.routing).map(([category, ids]) => [
        category,
        [...ids].sort(),
      ]),
    ]),
  );
  const dirty =
    JSON.stringify([
      values["policy-version"],
      values["ack-minutes"],
      values["org-timezone"],
      values["source-retention"],
      policy,
      fallback,
      routing.map((row) => [row.category, [...row.memberIds].sort()]),
    ]) !== baseline;
  const validateField = (id: string, value: string) =>
    setErrors((current) => ({
      ...current,
      [id]: fieldCheck[id]?.(value) ?? "",
    }));
  const validateRoute = (key: string, value: string) =>
    setRouteErrors((current) => ({
      ...current,
      [key]: value.trim() ? "" : "Enter a category name.",
    }));
  const fieldProps = (id: string) => ({
    id,
    required: true,
    value: values[id] ?? "",
    "aria-invalid": errors[id] ? (true as const) : undefined,
    "aria-describedby": describedBy(id, true, errors[id]),
    onChange: (event: { target: { value: string } }) => {
      const next = event.target.value;
      setValues((current) => ({ ...current, [id]: next }));
      if (errors[id]) validateField(id, next);
    },
    onBlur: () => validateField(id, values[id] ?? ""),
  });
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!membersReady) return;
    const nextErrors: Record<string, string> = {};
    for (const id of Object.keys(fieldCheck))
      nextErrors[id] = fieldCheck[id]?.(values[id] ?? "") ?? "";
    const nextRouteErrors: Record<string, string> = {};
    for (const row of routing)
      nextRouteErrors[row.key] = row.category.trim()
        ? ""
        : "Enter a category name.";
    setErrors(nextErrors);
    setRouteErrors(nextRouteErrors);
    const firstInvalid = [
      "policy-version",
      ...routing.map((row) => `route-category-${row.key}`),
      "ack-minutes",
      "org-timezone",
      "source-retention",
    ].find((id) =>
      id.startsWith("route-category-")
        ? nextRouteErrors[id.slice("route-category-".length)]
        : nextErrors[id],
    );
    if (firstInvalid) {
      setLocalError(
        Object.values(nextRouteErrors).some(Boolean)
          ? "Give each route a different, nonempty category."
          : "Check the highlighted settings fields before saving.",
      );
      document.getElementById(firstInvalid)?.focus();
      return;
    }
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
      timezone: values["org-timezone"] ?? "",
      automationPolicy: policy,
      policyVersion: values["policy-version"] ?? "",
      routing: routes,
      fallbackMembershipId: fallback || null,
      ackMinutes: Number(values["ack-minutes"]),
      retentionDays: Number(values["source-retention"]),
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
          noValidate
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
                <div className={styles.field}>
                  <label htmlFor="automation-policy">Automation policy</label>
                  <Select
                    id="automation-policy"
                    name="policy"
                    value={policy}
                    onChange={(event) => {
                      writer.change();
                      setPolicy(event.target.value);
                    }}
                  >
                    <option value="review-all">Review all</option>
                    <option value="validated-auto-record">
                      Validated auto-record
                    </option>
                  </Select>
                  <span className={styles.help}>
                    Auto-record applies only when server eligibility checks
                    pass. All other proposals wait for staff review.
                  </span>
                </div>
                <div className={styles.fieldWrap}>
                  <Field
                    id="policy-version"
                    label="Policy version"
                    required
                    hint="A short reference used to identify the active review rules."
                    error={errors["policy-version"] ?? ""}
                  >
                    <TextInput
                      {...fieldProps("policy-version")}
                      name="version"
                      maxLength={100}
                    />
                  </Field>
                </div>
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
                      <div className={styles.field}>
                        <label
                          className={styles.requiredLabel}
                          htmlFor={`route-category-${row.key}`}
                        >
                          Category
                        </label>
                        <TextInput
                          id={`route-category-${row.key}`}
                          value={row.category}
                          maxLength={100}
                          required
                          placeholder="For example, transport"
                          aria-invalid={routeErrors[row.key] ? true : undefined}
                          aria-describedby={
                            routeErrors[row.key]
                              ? `route-category-${row.key}-error`
                              : undefined
                          }
                          onBlur={(event) =>
                            validateRoute(row.key, event.target.value)
                          }
                          onChange={(event) => {
                            if (routeErrors[row.key])
                              validateRoute(row.key, event.target.value);
                            setRouting((rows) =>
                              rows.map((item) =>
                                item.key === row.key
                                  ? { ...item, category: event.target.value }
                                  : item,
                              ),
                            );
                          }}
                        />
                        {routeErrors[row.key] && (
                          <span
                            className={styles.fieldError}
                            id={`route-category-${row.key}-error`}
                          >
                            {routeErrors[row.key]}
                          </span>
                        )}
                      </div>
                      <div className={styles.routingRecipients}>
                        {members.map((member) => (
                          <label
                            key={member.membershipId}
                            className={styles.recipient}
                          >
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
                            <div key={id} className={styles.unavailable}>
                              Unavailable team member
                              <Button
                                variant="secondary"
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
                              </Button>
                            </div>
                          ))}
                      </div>
                      <Button
                        variant="danger"
                        className={styles.routeRemove}
                        onClick={() => {
                          writer.change();
                          setRouting((rows) =>
                            rows.filter((item) => item.key !== row.key),
                          );
                        }}
                      >
                        Remove route
                      </Button>
                    </fieldset>
                  ))}
                  <Button
                    variant="secondary"
                    className={styles.addRoute}
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
                  </Button>
                </section>
                <div className={styles.field}>
                  <label htmlFor="fallback-member">Fallback member</label>
                  <Select
                    id="fallback-member"
                    name="fallback"
                    value={fallback}
                    onChange={(event) => {
                      writer.change();
                      setFallback(event.target.value);
                    }}
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
                  </Select>
                  <span className={styles.help}>
                    Used when a category has no matching route.
                  </span>
                </div>
                <div className={styles.fieldWrap}>
                  <Field
                    id="ack-minutes"
                    label="Acknowledgment deadline"
                    required
                    hint="Time allowed for a person to acknowledge an assigned need."
                    error={errors["ack-minutes"] ?? ""}
                  >
                    <span className={styles.inputWithUnit}>
                      <TextInput
                        {...fieldProps("ack-minutes")}
                        name="ack"
                        type="number"
                        min="1"
                        max="10080"
                      />
                      <span>minutes</span>
                    </span>
                  </Field>
                </div>
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
                <div className={styles.fieldWrap}>
                  <Field
                    id="org-timezone"
                    label="Organization timezone"
                    required
                    hint="Use an IANA timezone such as America/Chicago."
                    error={errors["org-timezone"] ?? ""}
                  >
                    <TextInput
                      {...fieldProps("org-timezone")}
                      name="timezone"
                    />
                  </Field>
                </div>
                <div className={styles.fieldWrap}>
                  <Field
                    id="source-retention"
                    label="Source retention"
                    required
                    hint="Expired evidence becomes eligible for review; it is not removed automatically from this screen."
                    error={errors["source-retention"] ?? ""}
                  >
                    <span className={styles.inputWithUnit}>
                      <TextInput
                        {...fieldProps("source-retention")}
                        name="retention"
                        type="number"
                        min="1"
                        max="3650"
                      />
                      <span>days</span>
                    </span>
                  </Field>
                </div>
              </div>
            </section>
            {owner && (
              <div className={styles.formFooter}>
                <div className={styles.saveState}>
                  <strong className={dirty ? styles.dirty : styles.clean}>
                    {dirty ? "Unsaved changes" : "All changes saved"}
                  </strong>
                  <span>Saving creates a new settings revision.</span>
                </div>
                <Button type="submit" disabled={writer.busy || !dirty}>
                  {writer.busy ? "Saving…" : "Save settings"}
                </Button>
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
                    {n.readAt ? <Icon name="check" size={16} /> : null}
                  </span>
                  <div className={styles.notificationBody}>
                    <strong>{n.title}</strong>
                    <span>{new Date(n.createdAt).toLocaleString()}</span>
                    <div className={styles.notificationActions}>
                      {/^\/(?![/\\])/.test(n.appPath) && (
                        <a href={n.appPath}>
                          Open related work
                          <Icon name="arrowRight" size={16} />
                        </a>
                      )}
                      {!n.readAt && (
                        <Button
                          variant="secondary"
                          className={styles.smallButton}
                          disabled={writer.busy}
                          onClick={() => void read(n)}
                        >
                          Mark read
                        </Button>
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
            <Button variant="secondary" onClick={() => void list.reload()}>
              Try again
            </Button>
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
                <Button
                  type="submit"
                  className={styles.formAction}
                  disabled={writer.busy}
                >
                  {writer.busy ? "Saving…" : "Save preferences"}
                </Button>
              </form>
            ) : (
              <>
                <Status error={prefs.error} />
                <Button variant="secondary" onClick={() => void prefs.reload()}>
                  Try loading preferences again
                </Button>
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
              <Button
                disabled={writer.busy}
                onClick={() => void linkTelegram()}
              >
                Create link instruction
              </Button>
              <Button
                variant="secondary"
                disabled={writer.busy}
                onClick={async () => {
                  if ((await writer.write("telegram-unlink", {}, false)).ok) {
                    setLink(null);
                    setCopyMessage("");
                  }
                }}
              >
                Unlink Telegram
              </Button>
            </div>
            {link &&
              (link.token ? (
                <div className={styles.linkInstruction}>
                  <label htmlFor="telegram-instruction">
                    One-time instruction
                  </label>
                  <div className={styles.copyRow}>
                    <TextInput
                      id="telegram-instruction"
                      readOnly
                      value={`/link ${link.token}`}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      variant="secondary"
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
                    </Button>
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
const roleOptions = (
  <>
    <option value="volunteer">Volunteer</option>
    <option value="coordinator">Coordinator</option>
    <option value="report-reader">Report reader</option>
    <option value="owner">Owner</option>
  </>
);
function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}
function MemberRow({
  member,
  busy,
  onChange,
  onRole,
  onRemove,
}: {
  member: Member;
  busy: boolean;
  onChange: () => void;
  onRole: (member: Member, role: string) => Promise<void>;
  onRemove: (member: Member) => Promise<void>;
}) {
  const [role, setRole] = useState<string>(member.role);
  return (
    <li className={styles.memberRow}>
      <div className={styles.memberIdentity}>
        <span className={styles.memberAvatar} aria-hidden="true">
          {initials(member.name)}
        </span>
        <div>
          <strong>{member.name}</strong>
          <span>{member.email}</span>
        </div>
      </div>
      <span
        className={`${styles.roleBadge} ${styles[`role_${member.role.replace("-", "_")}`]}`}
      >
        {roleName[member.role]}
      </span>
      <form
        className={styles.memberActions}
        onSubmit={(e) => {
          e.preventDefault();
          void onRole(member, role);
        }}
        onChange={onChange}
      >
        <label
          className={styles.visuallyHidden}
          htmlFor={`member-role-${member.membershipId}`}
        >
          Role for {member.name}
        </label>
        <Select
          id={`member-role-${member.membershipId}`}
          name="role"
          value={role}
          onChange={(event) => {
            onChange();
            setRole(event.target.value);
          }}
        >
          {roleOptions}
        </Select>
        <Button type="submit" variant="secondary" disabled={busy}>
          Update role
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => void onRemove(member)}
        >
          Remove
        </Button>
      </form>
    </li>
  );
}
export function Members() {
  const list = useLoad<Member[]>("members");
  const writer = useWrite();
  const [inviteRole, setInviteRole] = useState("volunteer");
  const [emailError, setEmailError] = useState("");
  const checkEmail = (value: string) => {
    const text = value.trim();
    const problem = !text
      ? "Enter an email address."
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
        ? ""
        : "Enter a valid email address, such as name@example.org.";
    setEmailError(problem);
    return !problem;
  };
  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (!checkEmail(String(f.get("email") ?? ""))) {
      document.getElementById("invite-email")?.focus();
      return;
    }
    if (
      (
        await writer.write(
          "members/invite",
          { email: String(f.get("email")), role: inviteRole },
          false,
        )
      ).ok
    ) {
      form.reset();
      setEmailError("");
      setInviteRole("volunteer");
      await list.reload();
    }
  }
  async function changeRole(member: Member, role: string) {
    if (
      (
        await writer.write(
          "members/role",
          { membershipId: member.membershipId, role },
          false,
        )
      ).ok
    )
      await list.reload();
  }
  async function remove(member: Member) {
    if (
      (
        await writer.write(
          "members/remove",
          { membershipId: member.membershipId },
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
          noValidate
        >
          <div className={styles.fieldWrap}>
            <Field
              id="invite-email"
              label="Email address"
              required
              error={emailError}
            >
              <TextInput
                id="invite-email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="name@example.org"
                required
                aria-invalid={emailError ? true : undefined}
                aria-describedby={describedBy(
                  "invite-email",
                  false,
                  emailError,
                )}
                onBlur={(event) => checkEmail(event.target.value)}
                onChange={(event) => {
                  if (emailError) checkEmail(event.target.value);
                }}
              />
            </Field>
          </div>
          <div className={styles.field}>
            <label htmlFor="invite-role">Workspace role</label>
            <Select
              id="invite-role"
              name="role"
              value={inviteRole}
              onChange={(event) => {
                writer.change();
                setInviteRole(event.target.value);
              }}
            >
              {roleOptions}
            </Select>
          </div>
          <Button type="submit" disabled={writer.busy}>
            {writer.busy ? "Sending…" : "Send invitation"}
          </Button>
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
          <ul className={styles.roster}>
            {list.value.map((m) => (
              <MemberRow
                key={`${m.membershipId}-${m.role}`}
                member={m}
                busy={writer.busy}
                onChange={writer.change}
                onRole={changeRole}
                onRemove={remove}
              />
            ))}
          </ul>
        ) : list.error ? (
          <Button variant="secondary" onClick={() => void list.reload()}>
            Try again
          </Button>
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
