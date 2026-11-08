import { createHash } from "node:crypto";
import {
  assertValidBlob,
  type BlobCapacity,
  BlobError,
  type BlobIdentity,
  type BlobLifecycle,
  type BlobScanPage,
  type BlobSettlement,
  type BlobWrite,
  digestFromKey,
  type PrivateBlobStore,
  type RecoverOptions,
  storageKeyFor,
} from "./contracts.ts";
import { gatewayError, type S3Gateway } from "./gateway.ts";
import { detectedImageMime } from "./image.ts";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const OWNERSHIP_KEY = ".relay-deployment";

export interface S3BlobStoreOptions {
  gateway: S3Gateway;
  /** Stable identifier written to the bucket; a mismatch refuses startup. */
  deploymentId: string;
  maxBytes?: number;
  /** Default `unversioned`: a versioned bucket is refused unless opted in. */
  erasureMode?: "unversioned" | "versions";
  /** Hygiene only: the advisory lock, not this age, protects fresh writes. */
  reconcileMinimumAgeMs?: number;
}

/**
 * Content-addressed private bytes in an S3-compatible bucket.
 *
 * Writes are unconditional. Keys are digests, so a different payload can never
 * collide with an existing key and create-once semantics buy nothing — which
 * matters because several compatible services lack conditional writes.
 *
 * Erasure verifies the stored bytes against the key digest before deleting,
 * matching the filesystem backend. Metadata or checksum headers are not
 * accepted as proof. A versioned bucket keeps bytes alive behind delete
 * markers, so it is refused unless `erasureMode` is `versions`.
 */
export function createS3BlobStore(
  options: S3BlobStoreOptions,
): PrivateBlobStore {
  const { gateway } = options;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const erasureMode = options.erasureMode ?? "unversioned";
  const reconcileMinimumAgeMs = options.reconcileMinimumAgeMs ?? 3_600_000;
  let cursor: string | null = null;
  let ownershipVerified = false;

  async function ensureOwnership() {
    if (ownershipVerified) return;
    const expected = new TextEncoder().encode(options.deploymentId);
    const existing = await gateway.get(OWNERSHIP_KEY, 4096).catch((error) => {
      throw gatewayError("read ownership marker", error);
    });
    if (existing) {
      if (Buffer.from(existing).toString("utf8") !== options.deploymentId)
        throw new BlobError(
          "denied",
          "Bucket belongs to a different deployment; refusing to write",
        );
      ownershipVerified = true;
      return;
    }
    try {
      await gateway.put(OWNERSHIP_KEY, expected, "text/plain", {
        ifNoneMatch: true,
      });
    } catch (error) {
      // A concurrent first writer won the create; re-read is authoritative.
      if (!(error instanceof BlobError) || error.code !== "denied") throw error;
    }
    const after = await gateway.get(OWNERSHIP_KEY, 4096).catch((error) => {
      throw gatewayError("read ownership marker", error);
    });
    if (!after || Buffer.from(after).toString("utf8") !== options.deploymentId)
      throw new BlobError(
        "denied",
        "Bucket ownership could not be established for this deployment",
      );
    ownershipVerified = true;
  }

  const lifecycle: BlobLifecycle = {
    // Object storage has no local intent spool: reconciliation covers crashes.
    async begin() {},
    async end() {},
    async scan(next: string | null, limit: number): Promise<BlobScanPage> {
      const page = await gateway.list(next, limit).catch((error) => {
        throw gatewayError("list blobs", error);
      });
      return {
        cursor: page.cursor,
        entries: page.keys.flatMap((object) => {
          const sha256 = digestFromKey(object.key);
          return sha256
            ? [{ storageKey: object.key, sha256, updatedAt: object.updatedAt }]
            : [];
        }),
      };
    },
    async recover(settle: BlobSettlement, recoverOptions: RecoverOptions = {}) {
      const page = await lifecycle.scan(cursor, recoverOptions.limit ?? 100);
      cursor = page.cursor;
      const now = recoverOptions.now ?? Date.now();
      const minimumAgeMs = recoverOptions.minimumAgeMs ?? reconcileMinimumAgeMs;
      let examined = 0;
      for (const entry of page.entries) {
        // Age only avoids pointless churn; the caller's settlement re-checks
        // references under the shared advisory lock.
        if (now - entry.updatedAt.getTime() < minimumAgeMs) continue;
        examined++;
        try {
          await settle(entry, () => lifecycle.end(entry));
        } catch {
          console.warn(
            JSON.stringify({ event: "private-blob-recovery-pending" }),
          );
        }
      }
      return examined;
    },
    async close() {},
  };

  async function verifiedErase(blob: BlobIdentity) {
    assertValidBlob(blob);
    if (erasureMode === "versions") {
      // Every version of a digest key holds that same content, but a foreign
      // write could still land under it: verify the current object when it is
      // present, then remove all versions so no delete marker keeps the bytes.
      const current = await gateway.head(blob.storageKey).catch((error) => {
        throw gatewayError("head blob", error);
      });
      if (current) {
        if (current.size > maxBytes)
          throw new BlobError(
            "corrupt",
            "Erasure object exceeds the size bound",
          );
        const bytes = await gateway
          .get(blob.storageKey, maxBytes)
          .catch((error) => {
            throw gatewayError("read blob", error);
          });
        if (!bytes)
          throw new BlobError("corrupt", "Erasure bytes are unreadable");
        if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256)
          throw new BlobError("corrupt", "Erasure digest mismatch");
      }
      const versions = await gateway
        .listVersions(blob.storageKey)
        .catch((error) => {
          throw gatewayError("list versions", error);
        });
      for (const version of versions)
        await gateway
          .deleteVersion(blob.storageKey, version.versionId)
          .catch((error) => {
            throw gatewayError("delete version", error);
          });
      const remaining = await gateway
        .listVersions(blob.storageKey)
        .catch((error) => {
          throw gatewayError("list versions", error);
        });
      if (remaining.length)
        throw new BlobError(
          "unavailable",
          "Erasure left object versions behind",
          true,
        );
      return;
    }
    const object = await gateway.head(blob.storageKey).catch((error) => {
      throw gatewayError("head blob", error);
    });
    if (!object) return;
    if (object.size > maxBytes)
      throw new BlobError("corrupt", "Erasure object exceeds the size bound");
    const bytes = await gateway
      .get(blob.storageKey, maxBytes)
      .catch((error) => {
        throw gatewayError("read blob", error);
      });
    if (!bytes) throw new BlobError("corrupt", "Erasure bytes are unreadable");
    if (createHash("sha256").update(bytes).digest("hex") !== blob.sha256)
      throw new BlobError("corrupt", "Erasure digest mismatch");
    await gateway.delete(blob.storageKey).catch((error) => {
      throw gatewayError("delete blob", error);
    });
    const after = await gateway.head(blob.storageKey).catch((error) => {
      throw gatewayError("head blob", error);
    });
    if (after)
      throw new BlobError("unavailable", "Object remains after erasure", true);
  }

  return {
    backend: "s3",
    lifecycle,
    async put(bytes) {
      const data = Buffer.from(bytes);
      if (data.length === 0 || data.length > maxBytes)
        throw new BlobError("invalid", "Attachment size is invalid");
      const detected = detectedImageMime(data);
      if (!detected)
        throw new BlobError("invalid", "Unsupported image content");
      await ensureOwnership();
      const digest = createHash("sha256").update(data).digest("hex");
      const storageKey = storageKeyFor(digest);
      await gateway.put(storageKey, data, detected).catch((error) => {
        throw gatewayError("put blob", error);
      });
      return {
        storageKey,
        sha256: digest,
        mimeType: detected,
        bytes: data.length,
      } satisfies BlobWrite;
    },
    async read(key) {
      const sha256 = digestFromKey(key);
      if (!sha256) return null;
      try {
        const bytes = await gateway.get(key, maxBytes);
        if (!bytes) return null;
        if (createHash("sha256").update(bytes).digest("hex") !== sha256)
          return null;
        return bytes;
      } catch {
        return null;
      }
    },
    async erase(key, sha256) {
      const digest = digestFromKey(key);
      if (!digest || digest !== sha256)
        throw new BlobError("invalid", "Invalid erasure identity");
      await ensureOwnership();
      await verifiedErase({ storageKey: key, sha256 });
    },
    async capacity(): Promise<BlobCapacity> {
      // Object storage has no meaningful free-space figure; unknown stays null.
      return { availableBytes: null };
    },
    async probe() {
      await gateway.headBucket().catch((error) => {
        throw gatewayError("probe bucket", error);
      });
      await ensureOwnership();
    },
  };
}
