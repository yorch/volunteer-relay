import type { Environment } from "@relay/config";
import { createAwsS3Gateway } from "./aws-gateway.ts";
import { BlobError, type PrivateBlobStore } from "./contracts.ts";
import { createFilesystemBlobStore } from "./filesystem.ts";
import { createS3BlobStore } from "./s3.ts";

/**
 * Builds the configured store exactly once per process.
 *
 * The selected backend must be fully configured: a partial S3 configuration
 * throws instead of silently falling back to local disk, which would scatter
 * bytes across hosts.
 */
export function createBlobStore(env: Environment): PrivateBlobStore {
  if (env.BLOB_STORE === "filesystem")
    return createFilesystemBlobStore({
      root: env.ATTACHMENT_ROOT,
      maxBytes: env.ATTACHMENT_MAX_BYTES,
    });
  if (!env.S3_BUCKET || !env.S3_DEPLOYMENT_ID)
    throw new BlobError("invalid", "S3 blob storage is not configured");
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
