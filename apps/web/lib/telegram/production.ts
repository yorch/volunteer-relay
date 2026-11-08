import { randomUUID } from "node:crypto";
import {
  createBlobStore,
  type PrivateBlobStore,
  withTrackedBlobWrites,
} from "@relay/blob";
import { parseEnvironment } from "@relay/config";
import {
  createDatabase,
  createDomainStore,
  createFollowThroughRepository,
  createSourceStore,
  type Database,
  pruneUnreferencedBlob,
  sql,
} from "@relay/db";
import { createNeedService, createSourceRepository } from "@relay/domain/core";
import {
  createPhotoTransform,
  createTelegramRuntime,
  type TelegramTransactionalDependencies,
  verifyTelegramSecret,
} from "@relay/intake";
import sharp from "sharp";
import { createTenantAuthorization } from "../auth/index.ts";

/** Ingress services built from one transaction so every read shares it. */
function transactionalDependencies(
  db: Database,
): TelegramTransactionalDependencies {
  const authorization = createTenantAuthorization({ db });
  const links = createFollowThroughRepository(db),
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

let opened: ReturnType<typeof createDatabase> | undefined;
let blobs: PrivateBlobStore | undefined;
export async function telegramWebhook(request: Request) {
  try {
    const env = parseEnvironment(process.env);
    if (
      env.TELEGRAM_TRANSPORT !== "webhook" ||
      !env.TELEGRAM_BOT_TOKEN ||
      !env.TELEGRAM_WEBHOOK_SECRET
    )
      return new Response(null, { status: 503 });
    if (
      !verifyTelegramSecret(
        request.headers.get("x-telegram-bot-api-secret-token") ?? "",
        env.TELEGRAM_WEBHOOK_SECRET,
      )
    )
      return new Response(null, { status: 403 });
    opened ??= createDatabase(env.DATABASE_URL);
    blobs ??= createBlobStore(env);
    const database = opened.db;
    const store = blobs;
    const runtime = createTelegramRuntime({
      secret: env.TELEGRAM_WEBHOOK_SECRET,
      botToken: env.TELEGRAM_BOT_TOKEN,
      maxBytes: env.ATTACHMENT_MAX_BYTES,
      store,
      transform: createPhotoTransform(sharp),
      linked: async (identity) =>
        (
          await transactionalDependencies(
            database,
          ).links.resolveTelegramIdentity(identity)
        ).ok,
      // Photo download/decoding already happened; the transaction holds only
      // the blob lock, the blob put and source acceptance.
      transaction: (work) =>
        withTrackedBlobWrites(
          store,
          async (note) =>
            database.transaction(async (tx) => {
              const db = tx as unknown as Database;
              return work({
                deps: transactionalDependencies(db),
                lockBlob: async (storageKey, sha256) => {
                  await db.execute(
                    sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${storageKey}`},0))`,
                  );
                  await note({ storageKey, sha256 });
                },
              });
            }),
          (identity, done) =>
            pruneUnreferencedBlob(
              database,
              identity,
              (key, sha) => store.erase(key, sha),
              done,
            ),
        ),
    });
    return await runtime.handleRequest(request);
  } catch {
    return Response.json(
      { ok: false, correlationId: randomUUID() },
      { status: 503 },
    );
  }
}
