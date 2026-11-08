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
  createTelegramIngress,
  createTelegramPhotoLoader,
  verifyTelegramSecret,
} from "@relay/intake";
import sharp from "sharp";
import { createTenantAuthorization } from "../auth/index.ts";

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
    return await withTrackedBlobWrites(
      store,
      async (note) =>
        database.transaction(async (tx) => {
          const db = tx as unknown as Database,
            authorization = createTenantAuthorization({ db });
          const links = createFollowThroughRepository(db),
            sources = createSourceRepository({
              authorization,
              store: createSourceStore(db),
            });
          const handler = createTelegramIngress({
            secret: env.TELEGRAM_WEBHOOK_SECRET ?? "",
            links,
            authorization,
            sources,
            needs: createNeedService({
              authorization,
              store: createDomainStore(db),
            }),
            timezone: async (org) =>
              (await links.getSettingsInternal(org)).timezone,
            replaySource: async (context, key) => {
              const rows = await db.execute(
                sql`select source_id,revision from source_revision where organization_id=${context.organizationId} and channel='telegram' and idempotency_key=${key}`,
              );
              const row = rows.rows[0];
              return row
                ? sources.get(
                    context,
                    String(row.source_id),
                    Number(row.revision),
                  )
                : { ok: true as const, value: null };
            },
            photo: createTelegramPhotoLoader({
              botToken: env.TELEGRAM_BOT_TOKEN ?? "",
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
          return handler(request);
        }),
      (identity, done) =>
        pruneUnreferencedBlob(
          database,
          identity,
          (key, sha) => store.erase(key, sha),
          done,
        ),
    );
  } catch {
    return Response.json(
      { ok: false, correlationId: randomUUID() },
      { status: 503 },
    );
  }
}
