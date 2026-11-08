import { createHash } from "node:crypto";
import { BlobError } from "../contracts.ts";
import type {
  GatewayObject,
  GatewayPage,
  GatewayVersion,
  S3Gateway,
} from "../gateway.ts";

interface Stored {
  bytes: Uint8Array;
  contentType: string;
  updatedAt: Date;
}

/**
 * In-memory S3 gateway for contract tests.
 *
 * Deliberately models the failure modes that matter: conditional create,
 * bounded reads, absent objects, versioned erasure, and paged listing.
 */
export function createFakeS3Gateway(
  seed: Record<string, Uint8Array> = {},
): S3Gateway & {
  objects: Map<string, Stored>;
  versions: Map<string, Stored[]>;
  failNext: (error: unknown) => void;
  calls: string[];
} {
  const objects = new Map<string, Stored>();
  const versions = new Map<string, Stored[]>();
  const calls: string[] = [];
  let failure: unknown;
  const now = () => new Date(Date.now());

  const take = () => {
    if (failure === undefined) return;
    const error = failure;
    failure = undefined;
    throw error;
  };

  for (const [key, bytes] of Object.entries(seed))
    objects.set(key, {
      bytes,
      contentType: "application/octet-stream",
      updatedAt: now(),
    });

  return {
    objects,
    versions,
    calls,
    failNext(error: unknown) {
      failure = error;
    },
    async put(key, body, contentType, options) {
      calls.push(`put:${key}`);
      take();
      if (options?.ifNoneMatch && objects.has(key))
        throw new BlobError("denied", "put failed: precondition");
      objects.set(key, {
        bytes: Uint8Array.from(body),
        contentType,
        updatedAt: now(),
      });
      versions.delete(key);
    },
    async get(key, limit) {
      calls.push(`get:${key}`);
      take();
      const stored = objects.get(key);
      if (!stored || stored.bytes.byteLength > limit) return null;
      return stored.bytes;
    },
    async head(key): Promise<GatewayObject | null> {
      calls.push(`head:${key}`);
      take();
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        key,
        size: stored.bytes.byteLength,
        updatedAt: stored.updatedAt,
      };
    },
    async delete(key) {
      calls.push(`delete:${key}`);
      take();
      const stored = objects.get(key);
      if (stored) {
        const list = versions.get(key) ?? [];
        list.push(stored);
        versions.set(key, list);
      }
      objects.delete(key);
    },
    async list(cursor, limit): Promise<GatewayPage> {
      calls.push(`list:${cursor ?? ""}`);
      take();
      const keys = [...objects.keys()].sort();
      const remaining = cursor ? keys.filter((key) => key > cursor) : keys;
      const page = remaining.slice(0, limit);
      const next = remaining.length > limit ? (page.at(-1) ?? null) : null;
      return {
        keys: page.map((key) => {
          const stored = objects.get(key) as Stored;
          return {
            key,
            size: stored.bytes.byteLength,
            updatedAt: stored.updatedAt,
          };
        }),
        cursor: next,
      };
    },
    async headBucket() {
      calls.push("headBucket");
      take();
    },
    async listVersions(key): Promise<GatewayVersion[]> {
      calls.push(`listVersions:${key}`);
      take();
      const stored = objects.get(key);
      const list = versions.get(key) ?? [];
      return [
        ...(stored ? [{ versionId: "current", isDeleteMarker: false }] : []),
        ...list.map((_, index) => ({
          versionId: `v${index}`,
          isDeleteMarker: false,
        })),
      ];
    },
    async deleteVersion(key, versionId) {
      calls.push(`deleteVersion:${key}:${versionId}`);
      take();
      if (versionId === "current") {
        const stored = objects.get(key);
        if (stored) {
          const list = versions.get(key) ?? [];
          list.push(stored);
          versions.set(key, list);
        }
        objects.delete(key);
        return;
      }
      const list = versions.get(key) ?? [];
      const index = Number.parseInt(versionId.slice(1), 10);
      if (Number.isSafeInteger(index)) list.splice(index, 1);
      versions.set(key, list);
    },
  };
}

/** Content-addressed helper mirroring the adapter key layout. */
export function keyFor(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return `${digest.slice(0, 2)}/${digest}`;
}
