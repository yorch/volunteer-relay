import { timingSafeEqual } from "node:crypto";
import type {
  AuthorizationService,
  NeedService,
  Result,
  SourceEnvelope,
  SourceRepository,
  TenantContext,
} from "@relay/contracts";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./index.ts";
export interface TelegramIngressDependencies {
  secret: string;
  links: {
    consumeTelegramLink(
      token: string,
      identity: string,
    ): Promise<Result<unknown>>;
    selectTelegramOrganization(
      identity: string,
      organizationId: string,
    ): Promise<Result<unknown>>;
    resolveTelegramIdentity(identity: string): Promise<
      Result<{
        context: TenantContext;
        organizations: Array<{
          organizationId: string;
          membershipId: string;
          name: string;
        }>;
      }>
    >;
    getTelegramSourceRevision(
      context: TenantContext,
      channelIdentity: string,
      externalMessageId: string,
    ): Promise<Result<SourceEnvelope | null>>;
  };
  sources: SourceRepository;
  authorization: AuthorizationService;
  needs: NeedService;
  timezone(org: string): Promise<string>;
  replaySource?(
    context: TenantContext,
    key: string,
  ): Promise<Result<SourceEnvelope | null>>;
  photo?(
    fileId: string,
    context: TenantContext,
  ): Promise<SourceEnvelope["attachments"][number]>;
}
export function createTelegramIngress(deps: TelegramIngressDependencies) {
  return async (request: Request): Promise<Response> => {
    const error = (status: number) =>
      Response.json(
        { ok: false },
        { status, headers: { "cache-control": "no-store" } },
      );
    const received =
      request.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!deps.secret) return error(503);
    const a = Buffer.from(received),
      b = Buffer.from(deps.secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return error(403);
    if (request.method !== "POST") return error(405);
    let update: TelegramUpdate;
    try {
      const reader = request.body?.getReader();
      if (!reader) return error(422);
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const p = await reader.read();
          if (p.done) break;
          length += p.value.byteLength;
          if (length > 262144) {
            await reader.cancel();
            return error(413);
          }
          chunks.push(p.value);
        }
      } finally {
        reader.releaseLock();
      }
      update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return error(422);
    }
    const raw = update as unknown as {
      message?: {
        chat?: { id?: number; type?: string };
        from?: { id?: number };
        text?: string;
      };
      edited_message?: {
        chat?: { id?: number; type?: string };
        from?: { id?: number };
        text?: string;
      };
    };
    const message = raw.edited_message ?? raw.message;
    if (
      !message?.from?.id ||
      !Number.isSafeInteger(message.from.id) ||
      message.from.id <= 0 ||
      message.chat?.type !== "private" ||
      message.chat.id !== message.from.id
    )
      return error(422);
    const identity = String(message.from.id);
    const reply = (text: string) =>
      Response.json({
        method: "sendMessage",
        chat_id: message.chat?.id,
        text,
        disable_web_page_preview: true,
      });
    try {
      const text = message.text ?? "";
      if (text.startsWith("/link ")) {
        const result = await deps.links.consumeTelegramLink(
          text.slice(6).trim(),
          identity,
        );
        return result.ok
          ? reply(
              "Your account is connected. Use /orgs to see your organizations.",
            )
          : error(result.error.code === "DEPENDENCY_UNAVAILABLE" ? 503 : 403);
      }
      if (text.startsWith("/org ")) {
        const result = await deps.links.selectTelegramOrganization(
          identity,
          text.slice(5).trim(),
        );
        return result.ok
          ? reply("Organization selected for future updates.")
          : error(403);
      }
      const resolved = await deps.links.resolveTelegramIdentity(identity);
      if (!resolved.ok)
        return error(
          resolved.error.code === "DEPENDENCY_UNAVAILABLE" ? 503 : 403,
        );
      const context = resolved.value.context;
      if (text === "/orgs")
        return reply(
          resolved.value.organizations
            .map((o) => `${o.name}: /org ${o.organizationId}`)
            .join("\n"),
        );
      if (text.startsWith("/ack ")) {
        const args = text.trim().split(/\s+/);
        if (args.length !== 4) return error(422);
        const org = args[1] ?? "",
          needId = args[2] ?? "",
          revision = Number(args[3]);
        if (org !== context.organizationId) return error(403);
        if (context.actor.kind !== "user" || !Number.isSafeInteger(revision))
          return error(422);
        const current = await deps.authorization.resolve(
          context.actor.userId,
          org,
          context.correlationId,
        );
        if (!current.ok) return error(403);
        const result = await deps.needs.transition(current.value, {
          schemaVersion: 1,
          action: "acknowledge",
          needId,
          expectedRevision: revision,
          idempotencyKey: `telegram-ack:${identity}:${update.update_id}`,
        });
        return result.ok
          ? reply("Need acknowledged.")
          : error(result.error.code === "CONFLICT" ? 409 : 403);
      }
      const preliminary = normalizeTelegramUpdate(update, {
        organizationId: context.organizationId,
        membershipId:
          context.actor.kind === "user" ? context.actor.membershipId : null,
        timezone: await deps.timezone(context.organizationId),
        receivedAt: new Date().toISOString(),
      });
      if (!preliminary) return error(422);
      const priorUpdate = await deps.replaySource?.(
        context,
        preliminary.idempotencyKey,
      );
      if (priorUpdate && !priorUpdate.ok) return error(503);
      if (priorUpdate?.ok && priorUpdate.value) {
        const accepted = await deps.sources.accept(context, priorUpdate.value);
        return accepted.ok
          ? reply(
              `Received update. Receipt ${accepted.value.sourceId}, revision ${accepted.value.revision}.`,
            )
          : error(409);
      }
      const previous = await deps.links.getTelegramSourceRevision(
        context,
        preliminary.channelIdentity,
        preliminary.externalMessageId,
      );
      if (!previous.ok) return error(503);
      // A repeated Bot API update reuses the exact accepted envelope and receipt.
      if (previous.value?.idempotencyKey === preliminary.idempotencyKey) {
        const replay = await deps.sources.accept(context, previous.value);
        return replay.ok
          ? reply(
              `Received update. Receipt ${replay.value.sourceId}, revision ${replay.value.revision}.`,
            )
          : error(409);
      }
      const normalized = normalizeTelegramUpdate(update, {
        organizationId: context.organizationId,
        membershipId:
          context.actor.kind === "user" ? context.actor.membershipId : null,
        timezone: preliminary.timezone,
        receivedAt: preliminary.receivedAt,
        previousRevision: previous.value?.revision ?? 1,
      });
      if (!normalized) return error(422);
      if (raw.edited_message && !previous.value) return error(409);
      const photo = (update.edited_message ?? update.message)?.photo?.at(-1);
      if (photo) {
        if (!deps.photo) return error(503);
        normalized.attachments = [await deps.photo(photo.file_id, context)];
      }
      const result = await deps.sources.accept(context, normalized);
      return result.ok
        ? reply(
            `Received update. Receipt ${result.value.sourceId}, revision ${result.value.revision}.`,
          )
        : error(
            result.error.code === "DEPENDENCY_UNAVAILABLE"
              ? 503
              : result.error.code === "CONFLICT"
                ? 409
                : 403,
          );
    } catch {
      return error(503);
    }
  };
}
