import type {
  BlobIdentity,
  BlobSettlement,
  PrivateBlobStore,
} from "./contracts.ts";

/**
 * Runs `work`, recording every blob it touches, then settles each one.
 *
 * `settle` is the authority on whether the bytes survive: it re-checks
 * references under the shared `blob:<key>` advisory lock and erases only
 * unreferenced content. Intents are recorded before bytes are written so a
 * crash mid-transaction leaves recoverable evidence on filesystem volumes.
 */
export async function withTrackedBlobWrites<T>(
  store: PrivateBlobStore,
  work: (note: (blob: BlobIdentity) => Promise<void>) => Promise<T>,
  settle: BlobSettlement,
): Promise<T> {
  const touched = new Map<string, BlobIdentity>();
  try {
    return await work(async (blob) => {
      touched.set(blob.storageKey, blob);
      await store.lifecycle.begin(blob);
    });
  } finally {
    for (const blob of [...touched.values()].sort((a, b) =>
      a.storageKey.localeCompare(b.storageKey),
    )) {
      try {
        await settle(blob, () => store.lifecycle.end(blob));
      } catch {
        console.warn(JSON.stringify({ event: "private-blob-cleanup-pending" }));
      }
    }
  }
}
