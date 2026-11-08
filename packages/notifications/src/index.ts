import type {
  DomainEvent,
  NeedRecord,
  NotificationTransport,
  Result,
  TenantContext,
} from "@relay/contracts";
import nodemailer, { type Transporter } from "nodemailer";

type Message = Parameters<NotificationTransport["deliver"]>[1];
type Accepted = { providerId: string; status: "accepted" };
type Delivery = (message: Message) => Promise<string>;
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

export function safeAppPath(path: string): string | null {
  if (
    !path.startsWith("/workspace/") ||
    path.startsWith("//") ||
    /[\\\r\n]/.test(path) ||
    path.includes("..")
  )
    return null;
  try {
    const parsed = new URL(path, "https://relay.invalid");
    return parsed.origin === "https://relay.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : null;
  } catch {
    return null;
  }
}
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

function transport(send: Delivery): NotificationTransport {
  const replay = new Map<string, string>();
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
      const cached = replay.get(message.deliveryKey);
      if (cached) return ok(cached);
      try {
        const providerId = await send({ ...message, appPath: path });
        replay.set(message.deliveryKey, providerId);
        return ok(providerId);
      } catch (cause) {
        return error(
          context,
          cause instanceof Error && cause.name === "TimeoutError"
            ? "Delivery outcome indeterminate after timeout"
            : "Notification provider unavailable",
          true,
        );
      }
    },
  };
}

export function createSafeTestTransport(): NotificationTransport {
  let sequence = 0;
  return transport(async (message) => {
    sequence++;
    return `test-${sequence}-${message.deliveryKey}`;
  });
}

export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
  resolveRecipient(id: string): Promise<string | null>;
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
  return transport(async (message) => {
    const to = await options.resolveRecipient(message.recipientId);
    if (!to) throw new Error("Recipient unavailable");
    const path = safeAppPath(message.appPath)!;
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
  resolveChat(recipientId: string): Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
};
export function createTelegramTransport(
  options: TelegramOptions,
): NotificationTransport {
  const fetcher = options.fetch ?? fetch;
  return transport(async (message) => {
    const chat_id = await options.resolveChat(message.recipientId);
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
            text: `${message.template}\n\n${message.appPath}`,
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
