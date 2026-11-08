import { randomUUID } from "node:crypto";
import {
  type BlobIdentity,
  type PrivateBlobStore,
  withTrackedBlobWrites,
} from "@relay/blob";
import type { parseEnvironment } from "@relay/config";
import {
  createDomainStore,
  createFollowThroughRepository,
  createMembershipReader,
  createSourceStore,
  type Database,
  pruneUnreferencedBlob,
  sql,
} from "@relay/db";
import { createAuthorizationService } from "@relay/domain/auth";
import { createNeedService, createSourceRepository } from "@relay/domain/core";
import {
  createTelegramIngress,
  createTelegramPhotoLoader,
  type TelegramUpdate,
} from "@relay/intake";
import sharp from "sharp";
export async function pollTelegram(
  db: Database,
  env: ReturnType<typeof parseEnvironment>,
  store: PrivateBlobStore,
  stopped: () => boolean,
) {
  if (env.TELEGRAM_TRANSPORT !== "polling" || !env.TELEGRAM_BOT_TOKEN) return;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const pollingSecret = randomUUID();
  const handlerFor = (
    db: Database,
    note: (identity: BlobIdentity) => Promise<void>,
  ) => {
    const authorization = createAuthorizationService({
        memberships: createMembershipReader(db),
      }),
      links = createFollowThroughRepository(db),
      sources = createSourceRepository({
        authorization,
        store: createSourceStore(db),
      }),
      secret = pollingSecret;
    return createTelegramIngress({
      secret,
      links,
      authorization,
      sources,
      needs: createNeedService({ authorization, store: createDomainStore(db) }),
      timezone: async (org) => (await links.getSettingsInternal(org)).timezone,
      replaySource: async (context, key) => {
        const rows = await db.execute(
          sql`select source_id,revision from source_revision where organization_id=${context.organizationId} and channel='telegram' and idempotency_key=${key}`,
        );
        const row = rows.rows[0];
        return row
          ? sources.get(context, String(row.source_id), Number(row.revision))
          : { ok: true as const, value: null };
      },
      photo: createTelegramPhotoLoader({
        botToken: botToken,
        store,
        maxBytes: env.ATTACHMENT_MAX_BYTES,
        withBlobLock: async (key, put) => {
          await db.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${key}`},0))`,
          );
          await note({ storageKey: key, sha256: key.slice(3) });
          return put();
        },
        transform: async (bytes) =>
          sharp(Buffer.from(bytes), {
            limitInputPixels: 40000000,
            failOn: "warning",
          })
            .rotate()
            .resize({
              width: 2000,
              height: 2000,
              fit: "inside",
              withoutEnlargement: true,
            })
            .png()
            .toBuffer(),
      }),
    });
  };
  let offset: number | undefined;
  while (!stopped()) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset,
            timeout: 15,
            limit: 20,
            allowed_updates: ["message", "edited_message"],
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!response.ok) throw new Error("Polling unavailable");
      const body = (await response.json()) as {
        ok?: boolean;
        result?: TelegramUpdate[];
      };
      if (!body.ok || !Array.isArray(body.result))
        throw new Error("Polling unavailable");
      for (const update of body.result) {
        if (stopped()) break;
        if (!Number.isSafeInteger(update.update_id))
          throw new Error("Invalid update");
        const handled = await withTrackedBlobWrites(
          store,
          async (note) =>
            db.transaction(async (tx) =>
              handlerFor(
                tx as unknown as Database,
                note,
              )(
                new Request("http://worker.invalid/telegram", {
                  method: "POST",
                  headers: {
                    "x-telegram-bot-api-secret-token": pollingSecret,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(update),
                }),
              ),
            ),
          (identity, done) =>
            pruneUnreferencedBlob(
              db,
              identity,
              (key, sha) => store.erase(key, sha),
              done,
            ),
        );
        if (handled.status >= 500) throw new Error("Ingress unavailable");
        if (handled.ok) {
          const payload = (await handled.json()) as Record<string, unknown>;
          if (payload.method === "sendMessage") {
            const delivery = await fetch(
              `https://api.telegram.org/bot${botToken}/sendMessage`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10000),
              },
            );
            if (!delivery.ok)
              console.warn(
                JSON.stringify({
                  service: "worker",
                  event: "telegram-receipt-unavailable",
                }),
              );
          }
        }
        offset = update.update_id + 1;
      }
    } catch {
      console.warn(
        JSON.stringify({
          service: "worker",
          event: "telegram-poll-unavailable",
        }),
      );
      if (!stopped()) await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
