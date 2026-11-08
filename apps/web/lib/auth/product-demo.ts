import { createHash } from "node:crypto";
import { type PrivateBlobStore, withTrackedBlobWrites } from "@relay/blob";
import { type Database, pruneUnreferencedBlob, sql } from "@relay/db";
import sharp from "sharp";
import {
  insertDemoFixtures,
  inspectDemoProfile,
  productDemoPhotoSvg,
} from "../../../../packages/db/src/demo-data.ts";
import { requireDemoProfile } from "./demo.ts";

/** Explicit synthetic product profile. Authentication identities are provisioned separately. */
export async function seedProductDemo(
  dependencies: { db: Database; store: PrivateBlobStore },
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ created: boolean; profileVersion: 1 }> {
  requireDemoProfile(args, env);
  const { db, store } = dependencies;
  try {
    const png = await sharp(Buffer.from(productDemoPhotoSvg)).png().toBuffer();
    const sha256 = createHash("sha256").update(png).digest("hex");
    const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
    return await withTrackedBlobWrites(
      store,
      async (note) =>
        db.transaction(async (tx) => {
          if ((await inspectDemoProfile(tx)) === "reuse") {
            const tombstone = await tx.execute(
              sql`select 1 from source_redaction where organization_id='tidepath' and source_id='demo-product:v1:photo'`,
            );
            if (!tombstone.rows.length) {
              const rows = await tx.execute(
                sql`select storage_key,sha256 from source_attachment_identity where organization_id='tidepath' and source_id='demo-product:v1:photo' and attachment_id='demo-product:v1:photo-attachment'`,
              );
              const row = rows.rows[0];
              if (!row) throw new Error("Demo photo missing");
              const bytes = await store.read(row.storage_key as string);
              if (
                !bytes ||
                createHash("sha256").update(bytes).digest("hex") !== row.sha256
              )
                throw new Error("Demo photo missing");
            }
            return { created: false, profileVersion: 1 as const };
          }
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${storageKey}`},0))`,
          );
          await note({ storageKey, sha256 });
          const photo = await store.put(png);
          if (
            photo.storageKey !== storageKey ||
            photo.sha256 !== sha256 ||
            photo.mimeType !== "image/png" ||
            photo.bytes !== png.length
          )
            throw new Error("Synthetic photo storage mismatch");
          await insertDemoFixtures(tx, { ...photo, mimeType: "image/png" });
          return { created: true, profileVersion: 1 as const };
        }),
      (identity, done) =>
        pruneUnreferencedBlob(
          db,
          identity,
          (key, hash) => store.erase(key, hash),
          done,
        ),
    );
  } catch {
    throw new Error(
      "Product demo provisioning refused: conflict or unavailable dependency",
    );
  }
}
