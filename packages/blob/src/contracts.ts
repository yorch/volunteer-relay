/**
 * Private blob storage contract.
 *
 * Keys are content digests: `<2 hex>/<64 hex sha256>`. The digest is public
 * information only; it never grants authority. Every access is authorized by
 * the tenant-scoped metadata row before the store is touched.
 */
export const BLOB_KEY_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}$/;
export const BLOB_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface BlobIdentity {
  storageKey: string;
  sha256: string;
}

export type BlobMimeType = "image/jpeg" | "image/png" | "image/webp";

export type BlobWrite = BlobIdentity & {
  mimeType: BlobMimeType;
  bytes: number;
};

/**
 * Runs after a write attempt finishes, including success. `onSettled` releases
 * any write intent. Implementations re-check references under the shared
 * `blob:<key>` advisory lock; they must tolerate replay.
 */
export type BlobSettlement = (
  blob: BlobIdentity,
  onSettled: () => Promise<void>,
) => Promise<unknown>;

export interface RecoverOptions {
  now?: number;
  minimumAgeMs?: number;
  limit?: number;
}

export interface BlobScanEntry extends BlobIdentity {
  updatedAt: Date;
}

export interface BlobScanPage {
  entries: BlobScanEntry[];
  cursor: string | null;
}

export interface BlobCapacity {
  /** `null` means unknown: object storage has no meaningful free-space figure. */
  availableBytes: number | null;
}

export type BlobErrorCode =
  | "absent"
  | "denied"
  | "quota"
  | "unavailable"
  | "corrupt"
  | "invalid";

const retryableByDefault: Record<BlobErrorCode, boolean> = {
  absent: false,
  denied: false,
  quota: false,
  unavailable: true,
  corrupt: false,
  invalid: false,
};

export class BlobError extends Error {
  readonly code: BlobErrorCode;
  readonly retryable: boolean;

  constructor(code: BlobErrorCode, message: string, retryable?: boolean) {
    super(message);
    this.name = "BlobError";
    this.code = code;
    this.retryable = retryable ?? retryableByDefault[code];
  }
}

/**
 * Durable-write bookkeeping and bounded enumeration.
 *
 * The filesystem backend records per-blob intents next to the bytes so a crash
 * mid-transaction is recoverable from the same volume. Object storage cannot do
 * that, so it reconciles by enumerating the bucket instead. Both are exposed as
 * `recover(settle)` so the worker loop stays backend-agnostic.
 */
export interface BlobLifecycle {
  /** Record intent before bytes are written. Must be cheap and replay-safe. */
  begin(blob: BlobIdentity): Promise<void>;
  /** Release an intent. Missing intent is success. */
  end(blob: BlobIdentity): Promise<void>;
  /** Bounded, resumable enumeration of stored blobs. `cursor` is opaque. */
  scan(cursor: string | null, limit: number): Promise<BlobScanPage>;
  /**
   * One bounded recovery step: settle intents (filesystem) or reconcile a
   * page of unreferenced objects (object storage). Returns a count of blobs
   * examined or intents settled; callers must not treat it as progress proof.
   */
  recover(settle: BlobSettlement, options?: RecoverOptions): Promise<number>;
  close(): Promise<void>;
}

export interface PrivateBlobStore {
  readonly backend: "filesystem" | "s3";
  /** Idempotent per digest; identical bytes never collide with different ones. */
  put(bytes: Uint8Array): Promise<BlobWrite>;
  /** Bounded read by validated digest key; null when absent or unreadable. */
  read(key: string): Promise<Uint8Array | null>;
  /** Idempotent, digest-verified erase. Missing object is success. */
  erase(key: string, sha256: string): Promise<void>;
  capacity(): Promise<BlobCapacity>;
  /** Fail closed when the backend is missing, misconfigured or unwritable. */
  probe(): Promise<void>;
  readonly lifecycle: BlobLifecycle;
}

export function storageKeyFor(sha256: string): string {
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/** Returns the digest encoded by a validated key, or null. */
export function digestFromKey(key: string): string | null {
  if (!BLOB_KEY_PATTERN.test(key)) return null;
  const sha256 = key.slice(3);
  return storageKeyFor(sha256) === key ? sha256 : null;
}

export function isValidBlob(blob: BlobIdentity): boolean {
  return (
    BLOB_SHA256_PATTERN.test(blob?.sha256 ?? "") &&
    blob.storageKey === storageKeyFor(blob.sha256)
  );
}

export function assertValidBlob(blob: BlobIdentity): void {
  if (!isValidBlob(blob))
    throw new BlobError("invalid", "Invalid blob identity");
}
