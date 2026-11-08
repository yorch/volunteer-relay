import { type PrivateBlobStore, withTrackedBlobWrites } from "@relay/blob";
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
  createPhotoTransform,
  createTelegramRuntime,
  createTelegramUpdateAttempts,
  MAX_TELEGRAM_UPDATE_ATTEMPTS,
  type TelegramTransactionalDependencies,
  type TelegramUpdate,
} from "@relay/intake";
import sharp from "sharp";

/** Ingress services built from one transaction so every read shares it. */
function transactionalDependencies(
  db: Database,
): TelegramTransactionalDependencies {
  const authorization = createAuthorizationService({
      memberships: createMembershipReader(db),
    }),
    links = createFollowThroughRepository(db),
    sources = createSourceRepository({
      authorization,
      store: createSourceStore(db),
    });
  return {
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
  };
}

export async function pollTelegram(
  db: Database,
  env: ReturnType<typeof parseEnvironment>,
  store: PrivateBlobStore,
  stopped: () => boolean,
) {
  if (env.TELEGRAM_TRANSPORT !== "polling" || !env.TELEGRAM_BOT_TOKEN) return;
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const runtime = createTelegramRuntime({
    // Updates come from getUpdates, never from an inbound request.
    secret: "",
    botToken,
    maxBytes: env.ATTACHMENT_MAX_BYTES,
    store,
    transform: createPhotoTransform(sharp),
    linked: async (identity) =>
      (
        await transactionalDependencies(db).links.resolveTelegramIdentity(
          identity,
        )
      ).ok,
    transaction: (work) =>
      withTrackedBlobWrites(
        store,
        async (note) =>
          db.transaction(async (tx) => {
            const scoped = tx as unknown as Database;
            return work({
              deps: transactionalDependencies(scoped),
              lockBlob: async (storageKey, sha256) => {
                await scoped.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${storageKey}`},0))`,
                );
                await note({ storageKey, sha256 });
              },
            });
          }),
        (identity, done) =>
          pruneUnreferencedBlob(
            db,
            identity,
            (key, sha) => store.erase(key, sha),
            done,
          ),
      ),
  });
  const attempts = createTelegramUpdateAttempts();
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
        let handled: Response;
        try {
          handled = await runtime.handleUpdate(update);
        } catch {
          handled = new Response(null, { status: 503 });
        }
        if (handled.status >= 500) {
          if (!attempts.failed(update.update_id))
            throw new Error("Ingress unavailable");
          // Only the numeric update id is logged; never message content.
          console.warn(
            JSON.stringify({
              service: "worker",
              event: "telegram-update-skipped",
              updateId: update.update_id,
              attempts: MAX_TELEGRAM_UPDATE_ATTEMPTS,
            }),
          );
        } else if (handled.ok) {
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
            ).catch(() => null);
            if (!delivery?.ok)
              console.warn(
                JSON.stringify({
                  service: "worker",
                  event: "telegram-receipt-unavailable",
                }),
              );
          }
        }
        attempts.settled(update.update_id);
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
