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
import styles from "./product.module.css";

type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string } };
async function api<T>(path: string, body?: object): Promise<Result<T>> {
  try {
    const response = await fetch(`/api/product/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = (await response.json()) as Result<T>;
    if (value && typeof value.ok === "boolean") return value;
  } catch {}
  return { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } };
}
function message(code: string) {
  return code === "FORBIDDEN"
    ? "You do not have permission for this action."
    : code === "UNAUTHENTICATED"
      ? "Please sign in."
      : code === "CONFLICT"
        ? "This record changed. Reload and try again."
        : code === "VALIDATION"
          ? "Check the fields and try again."
          : "The service is unavailable. Please try again.";
}
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
function Panel({ children }: { children: ReactNode }) {
  return <section className={styles.card}>{children}</section>;
}
function Status({ error, notice }: { error: string; notice?: string }) {
  return (
    <>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
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
  return (
    <>
      <h1>Organization settings</h1>
      {data.loading ? (
        <p>Loading settings…</p>
      ) : data.value ? (
        <SettingsForm
          key={data.value.revision}
          initial={data.value}
          owner={snapshot.organization.role === "owner"}
          members={snapshot.members}
          reload={data.reload}
        />
      ) : (
        <>
          <Status error={data.error} />
          <button type="button" onClick={() => void data.reload()}>
            Try again
          </button>
        </>
      )}
    </>
  );
}
function SettingsForm({
  initial,
  owner,
  members,
  reload,
}: {
  initial: OrganizationSettings;
  owner: boolean;
  members: WorkspaceSnapshot["members"];
  reload: () => Promise<void>;
}) {
  const writer = useWrite();
  const [routing, setRouting] = useState(
    JSON.stringify(initial.routing, null, 2),
  );
  const [localError, setLocalError] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    let routes: unknown;
    try {
      routes = JSON.parse(routing);
    } catch {
      setLocalError("Routing must be a JSON object.");
      return;
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
      <p>
        Settings revision {initial.revision}.{" "}
        {owner
          ? "Changes apply to this organization."
          : "Only owners can change settings."}
      </p>
      <Panel>
        <form onSubmit={save} onChange={writer.change}>
          <fieldset disabled={!owner || writer.busy}>
            <label>
              Timezone
              <input name="timezone" defaultValue={initial.timezone} required />
            </label>
            <label>
              Automation policy
              <select name="policy" defaultValue={initial.automationPolicy}>
                <option value="review-all">Review all</option>
                <option value="validated-auto-record">
                  Validated auto-record
                </option>
              </select>
            </label>
            <p>
              Validated auto-record applies only when the server's eligibility
              checks pass; other proposals still need review.
            </p>
            <label>
              Policy version
              <input
                name="version"
                defaultValue={initial.policyVersion}
                required
                maxLength={100}
              />
            </label>
            <label>
              Routing (category to member ID array)
              <textarea
                value={routing}
                onChange={(e) => setRouting(e.target.value)}
                rows={6}
              />
            </label>
            <label>
              Fallback member
              <select
                name="fallback"
                defaultValue={initial.fallbackMembershipId ?? ""}
              >
                <option value="">None</option>
                {members.map((m) => (
                  <option key={m.membershipId} value={m.membershipId}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Acknowledgment deadline (minutes)
              <input
                name="ack"
                type="number"
                min="1"
                max="10080"
                defaultValue={initial.ackMinutes}
                required
              />
            </label>
            <label>
              Retention (days)
              <input
                name="retention"
                type="number"
                min="1"
                max="3650"
                defaultValue={initial.retentionDays}
                required
              />
            </label>
            {owner && <button type="submit">Save settings</button>}
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
    }
  }
  return (
    <>
      <h1>Notifications</h1>
      <Status error={writer.error || list.error} notice={writer.notice} />
      <Panel>
        <h2>Inbox</h2>
        {list.loading ? (
          <p>Loading notifications…</p>
        ) : list.value?.length ? (
          <ul>
            {list.value.map((n) => (
              <li key={n.id}>
                <strong>{n.title}</strong> · {n.readAt ? "Read" : "Unread"} ·{" "}
                {new Date(n.createdAt).toLocaleString()}{" "}
                {/^\/(?![/\\])/.test(n.appPath) && <a href={n.appPath}>Open</a>}{" "}
                {!n.readAt && (
                  <button
                    type="button"
                    disabled={writer.busy}
                    onClick={() => void read(n)}
                  >
                    Mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : list.error ? (
          <button type="button" onClick={() => void list.reload()}>
            Try again
          </button>
        ) : (
          <p>No notifications yet.</p>
        )}
      </Panel>
      <Panel>
        <h2>Delivery preferences</h2>
        {prefs.loading ? (
          <p aria-live="polite">Loading preferences…</p>
        ) : prefs.value ? (
          <form
            key={`${prefs.value.email}-${prefs.value.telegram}`}
            onSubmit={preferences}
            onChange={writer.change}
          >
            <label style={{ display: "flex", alignItems: "center" }}>
              <input
                type="checkbox"
                name="email"
                defaultChecked={prefs.value.email}
              />{" "}
              Email
            </label>
            <label style={{ display: "flex", alignItems: "center" }}>
              <input
                type="checkbox"
                name="telegram"
                defaultChecked={prefs.value.telegram}
              />{" "}
              Telegram
            </label>
            <button type="submit" disabled={writer.busy}>
              Save preferences
            </button>
          </form>
        ) : (
          <>
            <Status error={prefs.error} />
            <button type="button" onClick={() => void prefs.reload()}>
              Try loading preferences again
            </button>
          </>
        )}
      </Panel>
      <Panel>
        <h2>Telegram account</h2>
        <p>
          Create a link instruction that expires after ten minutes. Share it
          only with the official bot.
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
            type="button"
            disabled={writer.busy}
            onClick={async () => {
              if ((await writer.write("telegram-unlink", {}, false)).ok)
                setLink(null);
            }}
          >
            Unlink Telegram
          </button>
        </div>
        {link &&
          (link.token ? (
            <>
              <label>
                Instruction
                <input
                  readOnly
                  value={`/link ${link.token}`}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(`/link ${link.token}`);
                    setCopyMessage("Instruction copied.");
                  } catch {
                    setCopyMessage("Select and copy the instruction above.");
                  }
                }}
              >
                Copy instruction
              </button>
              {copyMessage && <p role="status">{copyMessage}</p>}
              <p>Expires {new Date(link.expiresAt).toLocaleString()}</p>
            </>
          ) : (
            <p>
              A token is unavailable for this request. Create a new link
              instruction.
            </p>
          ))}
      </Panel>
    </>
  );
}
type Member = {
  membershipId: string;
  name: string;
  email: string;
  role: ContractRole;
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
    <>
      <h1>Members</h1>
      <Status error={writer.error || list.error} notice={writer.notice} />
      <Panel>
        <h2>Invite a member</h2>
        <form onSubmit={invite} onChange={writer.change}>
          <label>
            Email
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="volunteer">
              <Roles />
            </select>
          </label>
          <button type="submit" disabled={writer.busy}>
            Send invitation
          </button>
        </form>
      </Panel>
      <Panel>
        <h2>Current members</h2>
        {list.loading ? (
          <p>Loading members…</p>
        ) : list.value?.length ? (
          list.value.map((m) => (
            <div className={styles.item} key={m.membershipId}>
              <p>
                <strong>{m.name}</strong> · {m.email} · {m.role}
              </p>
              <form onSubmit={(e) => void role(e, m)} onChange={writer.change}>
                <label>
                  Role for {m.name}
                  <select name="role" defaultValue={m.role}>
                    <Roles />
                  </select>
                </label>
                <button type="submit" disabled={writer.busy}>
                  Update role
                </button>
                <button
                  type="button"
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
                  Remove member
                </button>
              </form>
            </div>
          ))
        ) : list.error ? (
          <button type="button" onClick={() => void list.reload()}>
            Try again
          </button>
        ) : (
          <p>No members found.</p>
        )}
      </Panel>
    </>
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
