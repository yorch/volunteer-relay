import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

/** Internal orphan cleanup. The caller's eraser must validate paths and treat
 * an already-missing blob as success. Uploads hold the same lock before writing
 * bytes through source acceptance, including the enclosing transaction. */
export async function pruneUnreferencedBlob(
  db: Database,
  blob: { storageKey: string; sha256: string },
  erase: (storageKey: string, sha256: string) => Promise<void>,
  onSettled?: () => Promise<void>,
): Promise<boolean> {
  if (
    !blob ||
    typeof blob.storageKey !== "string" ||
    typeof blob.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(blob.sha256) ||
    blob.storageKey !== `${blob.sha256.slice(0, 2)}/${blob.sha256}`
  )
    throw new Error("Invalid blob identity");
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended('blob:' || ${blob.storageKey},0))`,
      );
      const refs = await tx.execute(
        sql`select 1 from source_attachment_identity a where a.storage_key=${blob.storageKey} and not exists (select 1 from source_redaction r where r.organization_id=a.organization_id and r.source_id=a.source_id) limit 1`,
      );
      const unreferenced = refs.rows.length === 0;
      if (unreferenced) await erase(blob.storageKey, blob.sha256);
      if (onSettled) await onSettled();
      return unreferenced;
    });
  } catch {
    throw new Error("Blob pruning unavailable");
  }
}
