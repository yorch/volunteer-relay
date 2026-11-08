import { createHash } from "node:crypto";
import {
  BLOB_KEY_PATTERN,
  BLOB_SHA256_PATTERN,
  type PrivateBlobStore,
  storageKeyFor,
} from "./contracts.ts";

/** One live attachment identity, as selected from the database. */
export interface LiveKey {
  storageKey: string;
  sha256: string;
  bytes: number;
}

export type KeyOutcome =
  | "copied"
  | "alreadyPresent"
  | "verified"
  | "missing"
  | "corrupt"
  | "failed"
  | "excluded";

export type MigrationMode = "copy" | "verify";

export interface MigrationSummary {
  live: number;
  copied: number;
  alreadyPresent: number;
  verified: number;
  missing: number;
  corrupt: number;
  failed: number;
  excluded: number;
  bytesCopied: number;
}

export interface MigrationProgress {
  processed: number;
}

export interface MigrationOptions {
  /** Business key: `storageKey`, `sha256` and the recorded byte length. */
  keys: AsyncIterable<LiveKey>;
  source: PrivateBlobStore;
  target: PrivateBlobStore;
  mode: MigrationMode;
  /** Bounded worker pool; clamped to 1..16. */
  concurrency?: number;
  /**
   * Runs each key's work inside a caller-supplied fence (the CLI uses the
   * `blob:<key>` advisory lock plus a live-reference re-check). Returning
   * `excluded` means the key is no longer live and must not be copied.
   */
  fence?: (
    key: LiveKey,
    work: () => Promise<KeyOutcome>,
  ) => Promise<KeyOutcome>;
  onProgress?: (progress: MigrationProgress) => void;
}

const digestOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Shaped and self-consistent: the key must encode the digest and a positive length. */
export function isValidLiveKey(key: LiveKey): boolean {
  return (
    BLOB_KEY_PATTERN.test(key.storageKey) &&
    BLOB_SHA256_PATTERN.test(key.sha256) &&
    key.storageKey === storageKeyFor(key.sha256) &&
    Number.isSafeInteger(key.bytes) &&
    key.bytes > 0
  );
}

/** Content matches the database row: same length and same digest. */
function matches(bytes: Uint8Array | null, key: LiveKey): boolean {
  return (
    bytes !== null &&
    bytes.byteLength === key.bytes &&
    digestOf(bytes) === key.sha256
  );
}

/**
 * One key. Absence and corruption are indistinguishable at the store contract
 * (`read` returns null for both), so every unreadable or unverified object fails
 * closed rather than being assumed absent.
 */
export async function migrateKey(
  key: LiveKey,
  source: PrivateBlobStore,
  target: PrivateBlobStore,
  mode: MigrationMode,
): Promise<KeyOutcome> {
  if (!isValidLiveKey(key)) return "corrupt";
  // Existing bytes only count when they are complete and correct; a truncated
  // object must be repaired, not accepted on digest alone.
  const present = await target.read(key.storageKey).catch(() => null);
  if (matches(present, key))
    return mode === "copy" ? "alreadyPresent" : "verified";
  if (mode === "verify") return "missing";
  const bytes = await source.read(key.storageKey).catch(() => null);
  if (!bytes) return "missing";
  if (!matches(bytes, key)) return "corrupt";
  try {
    const written = await target.put(bytes);
    if (
      written.storageKey !== key.storageKey ||
      written.sha256 !== key.sha256 ||
      written.bytes !== key.bytes
    )
      return "failed";
  } catch {
    return "failed";
  }
  // A put that is not readable and correct afterwards is not a success.
  const readBack = await target.read(key.storageKey).catch(() => null);
  return matches(readBack, key) ? "copied" : "failed";
}

function emptySummary(): MigrationSummary {
  return {
    live: 0,
    copied: 0,
    alreadyPresent: 0,
    verified: 0,
    missing: 0,
    corrupt: 0,
    failed: 0,
    excluded: 0,
    bytesCopied: 0,
  };
}

function record(
  summary: MigrationSummary,
  outcome: KeyOutcome,
  key: LiveKey,
): void {
  switch (outcome) {
    case "copied":
      summary.copied++;
      summary.bytesCopied += key.bytes;
      break;
    case "alreadyPresent":
      summary.alreadyPresent++;
      break;
    case "verified":
      summary.verified++;
      break;
    case "missing":
      summary.missing++;
      break;
    case "corrupt":
      summary.corrupt++;
      break;
    case "failed":
      summary.failed++;
      break;
    case "excluded":
      summary.excluded++;
      break;
  }
}

/**
 * A run only passes when every live key was accounted for and none failed.
 * `excluded` is acceptable: the fence proved the key stopped being live.
 */
export function isMigrationComplete(summary: MigrationSummary): boolean {
  return summary.missing === 0 && summary.corrupt === 0 && summary.failed === 0;
}

/**
 * Copies or verifies live blobs with a bounded worker pool. One key's failure is
 * isolated and counted; iterator errors propagate, so a broken work list cannot
 * look like a finished run.
 */
export async function runMigration(
  options: MigrationOptions,
): Promise<MigrationSummary> {
  const summary = emptySummary();
  const concurrency = Math.min(Math.max(options.concurrency ?? 4, 1), 16);
  // Async generators serialise concurrent `next()` calls, so a single iterator
  // is safe; keys are consumed at pool rate and never buffered.
  const iterator = options.keys[Symbol.asyncIterator]();

  const worker = async () => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      const key = next.value;
      summary.live++;
      const work = () =>
        migrateKey(key, options.source, options.target, options.mode);
      let outcome: KeyOutcome;
      try {
        outcome = options.fence ? await options.fence(key, work) : await work();
      } catch {
        outcome = "failed";
      }
      record(summary, outcome, key);
      options.onProgress?.({ processed: summary.live });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return summary;
}
