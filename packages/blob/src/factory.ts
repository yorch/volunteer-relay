import { statSync } from "node:fs";
import type { Environment } from "@relay/config";
import { createAwsS3Gateway } from "./aws-gateway.ts";
import { BlobError, type PrivateBlobStore } from "./contracts.ts";
import { createFallbackBlobStore } from "./fallback.ts";
import { createFilesystemBlobStore } from "./filesystem.ts";
import { createS3BlobStore } from "./s3.ts";

/** Filesystem store for `ATTACHMENT_ROOT`, independent of `BLOB_STORE`. */
export function createFilesystemStoreFromEnvironment(
  env: Environment,
): PrivateBlobStore {
  return createFilesystemBlobStore({
    root: env.ATTACHMENT_ROOT,
    maxBytes: env.ATTACHMENT_MAX_BYTES,
  });
}

/**
 * S3 store for the configured bucket, independent of `BLOB_STORE`.
 *
 * Migration tooling needs this while the deployment is still on filesystem, so
 * it must not depend on the active-backend switch.
 */
export function createS3StoreFromEnvironment(
  env: Environment,
): PrivateBlobStore {
  if (!env.S3_BUCKET || !env.S3_DEPLOYMENT_ID)
    throw new BlobError("invalid", "S3 blob storage is not configured");
  // Validate here as well as in the config schema: migration tooling builds an
  // S3 store while the deployment is still on `BLOB_STORE=filesystem`, and the
  // schema deliberately skips these checks in that mode.
  if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
    throw new BlobError(
      "invalid",
      "S3 credentials require both an access key and a secret",
    );
  if (
    env.S3_ENDPOINT?.startsWith("http://") &&
    (env.NODE_ENV === "production" || env.S3_ALLOW_INSECURE !== "true")
  )
    throw new BlobError(
      "invalid",
      "S3_ENDPOINT must use https outside development",
    );
  const gateway = createAwsS3Gateway({
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
    ...(env.S3_PREFIX ? { prefix: env.S3_PREFIX } : {}),
    ...(env.S3_FORCE_PATH_STYLE === undefined
      ? {}
      : { forcePathStyle: env.S3_FORCE_PATH_STYLE === "true" }),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
      : {}),
  });
  return createS3BlobStore({
    gateway,
    deploymentId: env.S3_DEPLOYMENT_ID,
    maxBytes: env.ATTACHMENT_MAX_BYTES,
    erasureMode: env.S3_ERASURE_MODE,
    reconcileMinimumAgeMs: env.S3_RECONCILE_MINIMUM_AGE_MS,
  });
}

function assertMountedDirectory(root: string): void {
  try {
    if (!statSync(root).isDirectory())
      throw new BlobError(
        "invalid",
        "BLOB_FALLBACK_ROOT is not a directory; is the volume mounted?",
      );
  } catch (error) {
    if (error instanceof BlobError) throw error;
    throw new BlobError(
      "invalid",
      "BLOB_FALLBACK_ROOT does not exist; is the volume mounted?",
    );
  }
}

/**
 * Builds the configured store exactly once per process.
 *
 * The selected backend must be fully configured: a partial S3 configuration
 * throws instead of silently falling back to local disk, which would scatter
 * bytes across hosts.
 */
export function createBlobStore(env: Environment): PrivateBlobStore {
  if (env.BLOB_STORE === "filesystem")
    return createFilesystemStoreFromEnvironment(env);
  const primary = createS3StoreFromEnvironment(env);
  if (!env.BLOB_FALLBACK_ROOT) return primary;
  // A fallback that is not mounted would otherwise be created as an empty
  // directory by the filesystem probe, silently losing every old attachment.
  assertMountedDirectory(env.BLOB_FALLBACK_ROOT);
  // Cutover window: reads fall back, erasure covers both, writes stay on S3.
  return createFallbackBlobStore({
    primary,
    fallback: createFilesystemBlobStore({
      root: env.BLOB_FALLBACK_ROOT,
      maxBytes: env.ATTACHMENT_MAX_BYTES,
    }),
  });
}
