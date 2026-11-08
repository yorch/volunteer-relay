import { randomUUID } from "node:crypto";
import { parseEnvironment } from "@relay/config";
import {
  createDatabase,
  createDomainStore,
  createFollowThroughRepository,
  createSourceStore,
  sql,
} from "@relay/db";
import { createNeedService, createSourceRepository } from "@relay/domain/core";
import { createTelegramPhotoLoader } from "@relay/intake";
import sharp from "sharp";
import { createTenantAuthorization } from "../auth/index.ts";
import { createTelegramIngress } from "./ingress.ts";

let handler: ReturnType<typeof createTelegramIngress> | undefined;
export async function telegramWebhook(request: Request) {
  try {
    const env = parseEnvironment(process.env);
    if (env.TELEGRAM_TRANSPORT !== "webhook" || !env.TELEGRAM_BOT_TOKEN)
      return new Response(null, { status: 503 });
    if (!handler) {
      const { db } = createDatabase(env.DATABASE_URL),
        authorization = createTenantAuthorization({ db });
      const links = createFollowThroughRepository(db),
        sources = createSourceRepository({
          authorization,
          store: createSourceStore(db),
        });
      handler = createTelegramIngress({
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
            ? sources.get(context, String(row.source_id), Number(row.revision))
            : { ok: true as const, value: null };
        },
        photo: createTelegramPhotoLoader({
          botToken: env.TELEGRAM_BOT_TOKEN,
          root: env.ATTACHMENT_ROOT,
          maxBytes: env.ATTACHMENT_MAX_BYTES,
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
    }
    return await handler(request);
  } catch {
    return Response.json(
      { ok: false, correlationId: randomUUID() },
      { status: 503 },
    );
  }
}
