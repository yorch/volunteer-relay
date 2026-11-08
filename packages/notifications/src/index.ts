import { createHash } from "node:crypto";
import {
  type DomainEvent,
  type NeedRecord,
  type NotificationTransport,
  type Result,
  safeAppPath,
  type TenantContext,
} from "@relay/contracts";
import nodemailer, { type Transporter } from "nodemailer";

type Message = Parameters<NotificationTransport["deliver"]>[1];
type Accepted = { providerId: string; status: "accepted" };
type Delivery = (context: TenantContext, message: Message) => Promise<string>;
const ok = (providerId: string): Result<Accepted> => ({
  ok: true,
  value: { providerId, status: "accepted" },
});
const error = (
  context: TenantContext,
  message: string,
  retryable: boolean,
): Result<Accepted> => ({
  ok: false,
  error: {
    code: "DEPENDENCY_UNAVAILABLE",
    message,
    correlationId: context.correlationId,
    retryable,
  },
});

export {
  isOrganizationHintId,
  safeAppPath,
  withOrganizationHint,
} from "@relay/contracts";

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
}

function isTimeout(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === "TimeoutError" ||
      ("code" in cause && cause.code === "ETIMEDOUT"))
  );
}

/**
 * In-process replay is only a short-lived optimisation for concurrent or
 * immediate retries; durable replay safety comes from the database lease and
 * accepted_at. The map is therefore bounded by age and entry count.
 */
export type ReplayCacheOptions = {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
};
type ReplayEntry = {
  digest: string;
  pending?: Promise<string>;
  expiresAt: number;
};

function transport(
  send: Delivery,
  options: ReplayCacheOptions = {},
): NotificationTransport {
  const maxEntries = Math.max(1, options.maxEntries ?? 1000);
  const ttlMs = Math.max(1, options.ttlMs ?? 60 * 60 * 1000);
  const now = options.now ?? Date.now;
  const entries = new Map<string, ReplayEntry>();
  const replay = {
    get(scope: string): ReplayEntry | undefined {
      const entry = entries.get(scope);
      if (entry && entry.expiresAt <= now()) {
        entries.delete(scope);
        return undefined;
      }
      return entry;
    },
    set(scope: string, entry: { digest: string; pending?: Promise<string> }) {
      const at = now();
      // Refresh recency: delete first so insertion order tracks last write.
      entries.delete(scope);
      for (const [key, value] of entries) {
        if (entries.size < maxEntries && value.expiresAt > at) break;
        entries.delete(key);
      }
      entries.set(scope, { ...entry, expiresAt: at + ttlMs });
    },
  };
  return {
    async deliver(context, message) {
      const path = safeAppPath(message.appPath);
      if (
        !path ||
        !message.deliveryKey ||
        !message.recipientId ||
        !message.template
      )
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Invalid notification payload",
            correlationId: context.correlationId,
            retryable: false,
          },
        };
      const scope = JSON.stringify([
        context.organizationId,
        message.recipientId,
        message.deliveryKey,
      ]);
      const digest = createHash("sha256")
        .update(JSON.stringify([message.template, path]))
        .digest("hex");
      const existing = replay.get(scope);
      if (existing && existing.digest !== digest)
        return {
          ok: false,
          error: {
            code: "CONFLICT",
            message: "Delivery key was reused with different content",
            correlationId: context.correlationId,
            retryable: false,
          },
        };
      if (existing?.pending) {
        try {
          return ok(await existing.pending);
        } catch (cause) {
          return error(
            context,
            isTimeout(cause)
              ? "Delivery outcome indeterminate after timeout"
              : "Notification provider unavailable",
            true,
          );
        }
      }
      const pending = send(context, { ...message, appPath: path });
      replay.set(scope, { digest, pending });
      try {
        const providerId = await pending;
        replay.set(scope, { digest, pending: Promise.resolve(providerId) });
        return ok(providerId);
      } catch (cause) {
        replay.set(scope, { digest });
        return error(
          context,
          isTimeout(cause)
            ? "Delivery outcome indeterminate after timeout"
            : "Notification provider unavailable",
          true,
        );
      }
    },
  };
}

export function createSafeTestTransport(
  deliver?: Delivery,
  replay?: ReplayCacheOptions,
): NotificationTransport {
  let sequence = 0;
  return transport(
    deliver ??
      (async (_context, message) => {
        sequence++;
        return `test-${sequence}-${message.deliveryKey}`;
      }),
    replay,
  );
}

export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
  appUrl?: string;
  resolveRecipient(organizationId: string, id: string): Promise<string | null>;
  timeoutMs?: number;
};
export function createSmtpTransport(
  options: SmtpOptions,
): NotificationTransport {
  const client: Transporter = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    auth: options.auth,
    connectionTimeout: options.timeoutMs ?? 10_000,
    greetingTimeout: options.timeoutMs ?? 10_000,
    socketTimeout: options.timeoutMs ?? 10_000,
  });
  return transport(async (context, message) => {
    const to = await options.resolveRecipient(
      context.organizationId,
      message.recipientId,
    );
    if (!to) throw new Error("Recipient unavailable");
    const path = options.appUrl
      ? new URL(message.appPath, options.appUrl).href
      : message.appPath;
    const result = await client.sendMail({
      from: options.from,
      to,
      subject: message.template,
      text: `${message.template}\n\nOpen ${path}`,
      html: `<p>${escapeHtml(message.template)}</p><p><a href="${escapeHtml(path)}">Open in Volunteer Relay</a></p>`,
      headers: { "X-Relay-Delivery-Key": message.deliveryKey },
    });
    return String(result.messageId ?? message.deliveryKey);
  });
}

export type TelegramOptions = {
  botToken: string;
  appUrl?: string;
  resolveChat(
    organizationId: string,
    recipientId: string,
  ): Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};
export function createTelegramTransport(
  options: TelegramOptions,
): NotificationTransport {
  const fetcher = options.fetch ?? fetch;
  return transport(async (context, message) => {
    const chat_id = await options.resolveChat(
      context.organizationId,
      message.recipientId,
    );
    if (!chat_id) throw new Error("Recipient unavailable");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Timed out", "TimeoutError")),
      options.timeoutMs ?? 10_000,
    );
    try {
      const response = await fetcher(
        `https://api.telegram.org/bot${options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            chat_id,
            text: `${message.template}\n\n${options.appUrl ? new URL(message.appPath, options.appUrl).href : message.appPath}`,
            disable_web_page_preview: true,
          }),
        },
      );
      if (!response.ok) throw new Error("Telegram rejected request");
      const payload = (await response.json()) as {
        ok?: boolean;
        result?: { message_id?: number };
      };
      if (!payload.ok || payload.result?.message_id === undefined)
        throw new Error("Telegram rejected request");
      return `telegram-${payload.result.message_id}`;
    } finally {
      clearTimeout(timer);
    }
  });
}

export type RoutingRules = {
  version: 1;
  categoryRoutes: Readonly<Record<string, readonly string[]>>;
  urgentFallback: readonly string[];
  routineFallback: readonly string[];
};
export type NeedRoute = {
  membershipIds: string[];
  ruleVersion: 1;
  reason: "category" | "urgent-fallback" | "routine-fallback";
};
export function routeNeedNotification(
  need: Pick<NeedRecord, "category" | "urgency">,
  rules: RoutingRules,
  activeMembershipIds: ReadonlySet<string>,
): NeedRoute {
  const specific = rules.categoryRoutes[need.category];
  const candidates = specific?.length
    ? specific
    : need.urgency === "urgent"
      ? rules.urgentFallback
      : rules.routineFallback;
  const reason = specific?.length
    ? "category"
    : need.urgency === "urgent"
      ? "urgent-fallback"
      : "routine-fallback";
  return {
    membershipIds: [...new Set(candidates)].filter((id) =>
      activeMembershipIds.has(id),
    ),
    ruleVersion: rules.version,
    reason,
  };
}

export type DeadlineDecision = {
  needId: string;
  action: "notify-owner" | "escalate";
  deadline: string;
};
export function evaluateNeedDeadlines(
  needs: readonly NeedRecord[],
  now: Date,
  activeMembershipIds: ReadonlySet<string>,
): DeadlineDecision[] {
  const decisions: DeadlineDecision[] = [];
  for (const need of needs) {
    if (["resolved", "cancelled", "acknowledged"].includes(need.status))
      continue;
    if (
      need.ownerMembershipId &&
      !activeMembershipIds.has(need.ownerMembershipId)
    )
      continue;
    if (!need.acknowledgeBy || Date.parse(need.acknowledgeBy) > now.getTime())
      continue;
    decisions.push({
      needId: need.needId,
      action: need.ownerMembershipId ? "escalate" : "notify-owner",
      deadline: need.acknowledgeBy,
    });
  }
  return decisions;
}

export function shouldHandleNeedReminder(
  event: DomainEvent,
  need: NeedRecord,
): boolean {
  return (
    event.type === "need.changed" &&
    event.aggregateId === need.needId &&
    !["resolved", "cancelled", "acknowledged"].includes(need.status)
  );
}
