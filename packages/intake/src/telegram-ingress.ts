import { timingSafeEqual } from "node:crypto";
import type { BlobWrite, PrivateBlobStore } from "@relay/blob";
import type {
  AuthorizationService,
  NeedService,
  Result,
  SourceEnvelope,
  SourceRepository,
  TenantContext,
} from "@relay/contracts";
import { normalizeTelegramUpdate, type TelegramUpdate } from "./index.ts";
import {
  createTelegramPhotoDownloader,
  isPermanentPhotoFailure,
  type PreparedTelegramPhoto,
  storeTelegramPhoto,
  TelegramPhotoError,
} from "./telegram-photo.ts";
export function verifyTelegramSecret(received: string, expected: string) {
  if (!expected) return false;
  const a = Buffer.from(received),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
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

const noStore = { "cache-control": "no-store" };
const failure = (status: number) =>
  Response.json({ ok: false }, { status, headers: noStore });
/** Terminally handled without a reply: Telegram must not redeliver it. */
const handled = () => Response.json({ ok: true }, { headers: noStore });
const transient = () => failure(503);
const unavailable = (result: { ok: false; error: { code: string } }) =>
  result.error.code === "DEPENDENCY_UNAVAILABLE";

export const TELEGRAM_REPLIES = {
  linked: "Your account is connected. Use /orgs to see your organizations.",
  linkInvalid:
    "This link code is invalid or has expired. Create a new one in Relay.",
  orgSelected: "Organization selected for future updates.",
  orgUnavailable:
    "That organization is not available. Use /orgs to see your organizations.",
  notConnected:
    "This Telegram account is not connected to an organization. Send /link with a code from Relay, or choose one with /org.",
  ackUsage: "Use /ack <organization> <need> <revision>.",
  ackDenied: "That need cannot be acknowledged from this account.",
  ackConflict: "That need has changed. Open Relay to see its latest revision.",
  acknowledged: "Need acknowledged.",
  unreadable: "This message could not be recorded. Send text or a photo.",
  unknownEdit:
    "Only edits to messages Relay already received can be recorded. Send the update as a new message.",
  photoRejected:
    "This photo could not be processed. Send a JPEG, PNG or WebP photo within the size limit.",
  rejected: "This update could not be recorded from this account.",
} as const;

type ReadOutcome =
  | { ok: true; update: TelegramUpdate }
  | { ok: false; response: Response };

/** Verifies the secret and reads a bounded JSON update. */
export async function readTelegramRequest(
  request: Request,
  secret: string,
): Promise<ReadOutcome> {
  const stop = (status: number): ReadOutcome => ({
    ok: false,
    response: failure(status),
  });
  const received = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret) return stop(503);
  if (!verifyTelegramSecret(received, secret)) return stop(403);
  if (request.method !== "POST") return stop(405);
  try {
    const reader = request.body?.getReader();
    if (!reader) return stop(422);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const p = await reader.read();
        if (p.done) break;
        length += p.value.byteLength;
        if (length > 262144) {
          await reader.cancel();
          return stop(413);
        }
        chunks.push(p.value);
      }
    } finally {
      reader.releaseLock();
    }
    const update = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!update || typeof update !== "object") return stop(422);
    return { ok: true, update: update as TelegramUpdate };
  } catch {
    return stop(422);
  }
}

type RawMessage = {
  chat?: { id?: number; type?: string };
  from?: { id?: number };
  text?: string;
  edit_date?: number;
};
/** The private-chat sender of an update, or null when it must be ignored. */
function privateMessage(update: TelegramUpdate): RawMessage | null {
  const raw = update as unknown as {
    message?: RawMessage;
    edited_message?: RawMessage;
  };
  const message = raw.edited_message ?? raw.message;
  if (
    !message?.from?.id ||
    !Number.isSafeInteger(message.from.id) ||
    message.from.id <= 0 ||
    message.chat?.type !== "private" ||
    message.chat.id !== message.from.id
  )
    return null;
  return message;
}

/** The largest photo file of a private message, if any. */
export function telegramPhotoFileId(update: TelegramUpdate): string | null {
  if (!privateMessage(update)) return null;
  return (
    (update.edited_message ?? update.message)?.photo?.at(-1)?.file_id ?? null
  );
}

/**
 * Handles one verified update. 2xx means terminally handled (Telegram must
 * not redeliver); 5xx is reserved for transient failures worth retrying.
 */
export async function handleTelegramUpdate(
  deps: Omit<TelegramIngressDependencies, "secret">,
  update: TelegramUpdate,
): Promise<Response> {
  const message = privateMessage(update);
  // Group/channel posts and anonymous senders are outside Relay intake.
  if (!message) return handled();
  const identity = String(message.from?.id);
  const reply = (text: string) =>
    Response.json(
      {
        method: "sendMessage",
        chat_id: message.chat?.id,
        text,
        disable_web_page_preview: true,
      },
      { headers: noStore },
    );
  const recorded = (receipt: { sourceId: string; revision: number }) =>
    reply(
      `Received update. Receipt ${receipt.sourceId}, revision ${receipt.revision}.`,
    );
  const accepted = (
    result: Awaited<ReturnType<SourceRepository["accept"]>>,
  ): Response =>
    result.ok
      ? recorded(result.value)
      : unavailable(result)
        ? transient()
        : reply(TELEGRAM_REPLIES.rejected);
  try {
    const text = message.text ?? "";
    if (text.startsWith("/link ")) {
      const result = await deps.links.consumeTelegramLink(
        text.slice(6).trim(),
        identity,
      );
      if (result.ok) return reply(TELEGRAM_REPLIES.linked);
      return unavailable(result)
        ? transient()
        : reply(TELEGRAM_REPLIES.linkInvalid);
    }
    if (text.startsWith("/org ")) {
      const result = await deps.links.selectTelegramOrganization(
        identity,
        text.slice(5).trim(),
      );
      if (result.ok) return reply(TELEGRAM_REPLIES.orgSelected);
      return unavailable(result)
        ? transient()
        : reply(TELEGRAM_REPLIES.orgUnavailable);
    }
    const resolved = await deps.links.resolveTelegramIdentity(identity);
    if (!resolved.ok)
      return unavailable(resolved)
        ? transient()
        : reply(TELEGRAM_REPLIES.notConnected);
    const context = resolved.value.context;
    if (text === "/orgs")
      return reply(
        resolved.value.organizations
          .map((o) => `${o.name}: /org ${o.organizationId}`)
          .join("\n"),
      );
    if (text.startsWith("/ack ")) {
      const args = text.trim().split(/\s+/);
      if (args.length !== 4) return reply(TELEGRAM_REPLIES.ackUsage);
      const org = args[1] ?? "",
        needId = args[2] ?? "",
        revision = Number(args[3]);
      if (org !== context.organizationId)
        return reply(TELEGRAM_REPLIES.ackDenied);
      if (context.actor.kind !== "user" || !Number.isSafeInteger(revision))
        return reply(TELEGRAM_REPLIES.ackUsage);
      const current = await deps.authorization.resolve(
        context.actor.userId,
        org,
        context.correlationId,
      );
      if (!current.ok)
        return unavailable(current)
          ? transient()
          : reply(TELEGRAM_REPLIES.ackDenied);
      const result = await deps.needs.transition(current.value, {
        schemaVersion: 1,
        action: "acknowledge",
        needId,
        expectedRevision: revision,
        idempotencyKey: `telegram-ack:${identity}:${update.update_id}`,
      });
      if (result.ok) return reply(TELEGRAM_REPLIES.acknowledged);
      return unavailable(result)
        ? transient()
        : reply(
            result.error.code === "CONFLICT"
              ? TELEGRAM_REPLIES.ackConflict
              : TELEGRAM_REPLIES.ackDenied,
          );
    }
    const preliminary = normalizeTelegramUpdate(update, {
      organizationId: context.organizationId,
      membershipId:
        context.actor.kind === "user" ? context.actor.membershipId : null,
      timezone: await deps.timezone(context.organizationId),
      receivedAt: new Date().toISOString(),
    });
    if (!preliminary) return reply(TELEGRAM_REPLIES.unreadable);
    const priorUpdate = await deps.replaySource?.(
      context,
      preliminary.idempotencyKey,
    );
    if (priorUpdate && !priorUpdate.ok) return transient();
    if (priorUpdate?.ok && priorUpdate.value)
      return accepted(await deps.sources.accept(context, priorUpdate.value));
    const previous = await deps.links.getTelegramSourceRevision(
      context,
      preliminary.channelIdentity,
      preliminary.externalMessageId,
    );
    if (!previous.ok) return transient();
    // A repeated Bot API update reuses the exact accepted envelope and receipt.
    if (previous.value?.idempotencyKey === preliminary.idempotencyKey)
      return accepted(await deps.sources.accept(context, previous.value));
    if (update.edited_message) {
      if (!previous.value) return reply(TELEGRAM_REPLIES.unknownEdit);
      // Edits can arrive out of order; one not newer than the latest stored
      // revision is stale and must not replace it.
      const latest = previous.value.occurredAt
        ? Date.parse(previous.value.occurredAt)
        : Number.NaN;
      const editedAt = Date.parse(preliminary.occurredAt ?? "");
      if (Number.isFinite(latest) && !(editedAt > latest)) return handled();
    }
    const normalized = normalizeTelegramUpdate(update, {
      organizationId: context.organizationId,
      membershipId:
        context.actor.kind === "user" ? context.actor.membershipId : null,
      timezone: preliminary.timezone,
      receivedAt: preliminary.receivedAt,
      previousRevision: previous.value?.revision ?? 1,
    });
    if (!normalized) return reply(TELEGRAM_REPLIES.unreadable);
    const photo = (update.edited_message ?? update.message)?.photo?.at(-1);
    if (photo) {
      if (!deps.photo) return transient();
      try {
        normalized.attachments = [await deps.photo(photo.file_id, context)];
      } catch (error) {
        if (isPermanentPhotoFailure(error))
          return reply(TELEGRAM_REPLIES.photoRejected);
        return transient();
      }
    }
    return accepted(await deps.sources.accept(context, normalized));
  } catch {
    return transient();
  }
}

export function createTelegramIngress(deps: TelegramIngressDependencies) {
  return async (request: Request): Promise<Response> => {
    const read = await readTelegramRequest(request, deps.secret);
    return read.ok ? handleTelegramUpdate(deps, read.update) : read.response;
  };
}

/** Services built from one transaction; the photo step is supplied separately. */
export type TelegramTransactionalDependencies = Omit<
  TelegramIngressDependencies,
  "secret" | "photo"
>;
export type TelegramTransactionScope = {
  deps: TelegramTransactionalDependencies;
  /** Serialises a blob key and records the tracked write before its put. */
  lockBlob(storageKey: string, sha256: string): Promise<void>;
};

/**
 * Shared Telegram ingress wiring for the webhook and the poller. Photo
 * download and decoding run before the transaction opens; inside it only the
 * blob lock, the blob put and source acceptance run.
 */
export function createTelegramRuntime(options: {
  secret: string;
  botToken: string;
  maxBytes: number;
  store: PrivateBlobStore;
  transform: (bytes: Uint8Array) => Promise<Uint8Array>;
  fetch?: typeof fetch;
  /**
   * Cheap sender check run before any photo is downloaded, so an unlinked
   * Telegram user cannot make Relay fetch and decode files.
   */
  linked?(identity: string): Promise<boolean>;
  transaction(
    work: (scope: TelegramTransactionScope) => Promise<Response>,
  ): Promise<Response>;
}) {
  const download = createTelegramPhotoDownloader(options);
  async function handleUpdate(update: TelegramUpdate): Promise<Response> {
    const fileId = telegramPhotoFileId(update);
    let prepared: PreparedTelegramPhoto | undefined;
    let rejected: TelegramPhotoError | undefined;
    const sender = privateMessage(update)?.from?.id;
    if (
      fileId &&
      options.linked &&
      !(await options.linked(String(sender)).catch(() => true))
    ) {
      // The handler replies "not connected" before it would read the photo.
    } else if (fileId) {
      try {
        prepared = await download(fileId);
      } catch (error) {
        if (!isPermanentPhotoFailure(error)) return transient();
        rejected = error as TelegramPhotoError;
      }
    }
    return options.transaction((scope) =>
      handleTelegramUpdate(
        {
          ...scope.deps,
          photo: async (id, context) => {
            if (rejected) throw rejected;
            if (!prepared || prepared.fileId !== id)
              throw new TelegramPhotoError(false, "Photo unavailable");
            const photo = prepared;
            return storeTelegramPhoto(
              photo,
              context,
              options.store,
              async (key, put): Promise<BlobWrite> => {
                await scope.lockBlob(key, photo.sha256);
                return put();
              },
            );
          },
        },
        update,
      ),
    );
  }
  return {
    handleUpdate,
    async handleRequest(request: Request): Promise<Response> {
      const read = await readTelegramRequest(request, options.secret);
      return read.ok ? handleUpdate(read.update) : read.response;
    },
  };
}

/** A poller update still failing transiently after this many tries is skipped. */
export const MAX_TELEGRAM_UPDATE_ATTEMPTS = 5;
/**
 * Counts consecutive transient failures of the update at the head of the
 * poll queue, so one poison update cannot block all later intake.
 */
export function createTelegramUpdateAttempts(
  limit = MAX_TELEGRAM_UPDATE_ATTEMPTS,
) {
  let current: { updateId: number; failures: number } | undefined;
  return {
    /** Records a failure; true once the update should be skipped. */
    failed(updateId: number): boolean {
      current =
        current?.updateId === updateId
          ? { updateId, failures: current.failures + 1 }
          : { updateId, failures: 1 };
      return current.failures >= limit;
    },
    settled(updateId: number) {
      if (current?.updateId === updateId) current = undefined;
    },
  };
}
