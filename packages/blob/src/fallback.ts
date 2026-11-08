import { createHash } from "node:crypto";
import {
  type BlobCapacity,
  BlobError,
  type BlobLifecycle,
  type BlobWrite,
  digestFromKey,
  type PrivateBlobStore,
} from "./contracts.ts";

export interface FallbackBlobStoreOptions {
  /** The backend that receives all new writes. */
  primary: PrivateBlobStore;
  /** A frozen store kept readable and erasable while a cutover is in progress. */
  fallback: PrivateBlobStore;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Composed store for a cutover window: new writes land in the primary, old
 * attachments stay readable from the frozen store, and erasure covers both.
 *
 * Both-store erasure is the reason this type exists. The retention job invokes
 * the eraser exactly once and turns any throw into a failed attempt that stays
 * open (`packages/db/src/repositories/retention.ts`), so reporting success while
 * one store still holds the bytes would record a completed erasure that never
 * happened.
 */
export function createFallbackBlobStore(
  options: FallbackBlobStoreOptions,
): PrivateBlobStore {
  const { primary, fallback } = options;

  const lifecycle: BlobLifecycle = primary.lifecycle;

  return {
    backend: "transition",
    lifecycle,
    async put(bytes): Promise<BlobWrite> {
      // The frozen store must never receive new bytes: they would be invisible
      // to reconciliation and would survive a fallback-only erasure.
      return primary.put(bytes);
    },
    async read(key) {
      const sha256 = digestFromKey(key);
      if (!sha256) return null;
      // Filesystem reads do not verify content, so verify here and give callers
      // one contract regardless of which store answered.
      for (const store of [primary, fallback]) {
        const bytes = await store.read(key).catch(() => null);
        if (bytes && digestOf(bytes) === sha256) return bytes;
      }
      return null;
    },
    async erase(key, sha256) {
      const digest = digestFromKey(key);
      if (!digest || digest !== sha256)
        throw new BlobError("invalid", "Invalid erasure identity");
      // Attempt both, always, even when the first rejects.
      const results = await Promise.allSettled([
        primary.erase(key, sha256),
        fallback.erase(key, sha256),
      ]);
      if (results.some((result) => result.status === "rejected"))
        throw new BlobError(
          "unavailable",
          "Erasure incomplete: the object may remain in one or more stores",
          true,
        );
    },
    async capacity(): Promise<BlobCapacity> {
      // Only the primary grows.
      return primary.capacity();
    },
    async probe() {
      await primary.probe();
      // A missing fallback volume means live attachments are unreachable, so
      // readiness must fail instead of serving per-request errors.
      await fallback.probe();
    },
  };
}
