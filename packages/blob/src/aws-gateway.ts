import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  type GatewayObject,
  type GatewayPage,
  type GatewayVersion,
  gatewayError,
  type S3Gateway,
} from "./gateway.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export interface AwsS3GatewayOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  prefix?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

function normalisePrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed ? `${trimmed}/` : "";
}

/**
 * `@aws-sdk/client-s3` adapter over the minimal gateway port.
 *
 * The SDK is isolated here so no other package (and no client bundle) imports
 * it. Only lowest-common-denominator operations are used; see `gateway.ts`.
 */
export function createAwsS3Gateway(options: AwsS3GatewayOptions): S3Gateway {
  const prefix = normalisePrefix(options.prefix);
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle === undefined
      ? {}
      : { forcePathStyle: options.forcePathStyle }),
    ...(options.accessKeyId && options.secretAccessKey
      ? {
          credentials: {
            accessKeyId: options.accessKeyId,
            secretAccessKey: options.secretAccessKey,
          },
        }
      : {}),
    maxAttempts: 3,
  });
  const real = (key: string) => `${prefix}${key}`;
  const logical = (key: string) =>
    prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;

  const send = <T>(operation: string, command: unknown): Promise<T> =>
    client
      .send(command as never, {
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      .catch((error: unknown) => {
        throw gatewayError(operation, error);
      }) as Promise<T>;

  return {
    async put(key, body, contentType, putOptions) {
      await send(
        "put",
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: real(key),
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
          ...(putOptions?.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        }),
      );
    },
    async get(key, limit) {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: options.bucket,
            Key: real(key),
            Range: `bytes=0-${limit}`,
          }),
          { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        const total = /^bytes \d+-\d+\/(\d+)$/.exec(
          response.ContentRange ?? "",
        )?.[1];
        if (total && Number(total) > limit) return null;
        const bytes = await response.Body?.transformToByteArray();
        if (!bytes || bytes.byteLength > limit) return null;
        return bytes;
      } catch (error) {
        const mapped = gatewayError("get", error);
        if (mapped.code === "absent") return null;
        throw mapped;
      }
    },
    async head(key): Promise<GatewayObject | null> {
      try {
        const response = await client.send(
          new HeadObjectCommand({
            Bucket: options.bucket,
            Key: real(key),
          }),
          { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        );
        return {
          key,
          size: response.ContentLength ?? 0,
          updatedAt: response.LastModified ?? new Date(0),
        };
      } catch (error) {
        const mapped = gatewayError("head", error);
        if (mapped.code === "absent") return null;
        throw mapped;
      }
    },
    async delete(key) {
      await send(
        "delete",
        new DeleteObjectCommand({ Bucket: options.bucket, Key: real(key) }),
      );
    },
    async list(cursor, limit): Promise<GatewayPage> {
      const response = await send<{
        Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
        NextContinuationToken?: string;
      }>(
        "list",
        new ListObjectsV2Command({
          Bucket: options.bucket,
          Prefix: prefix || undefined,
          MaxKeys: Math.min(Math.max(limit, 1), 1000),
          ...(cursor ? { ContinuationToken: cursor } : {}),
        }),
      );
      const keys: GatewayObject[] = [];
      for (const entry of response.Contents ?? []) {
        if (!entry.Key) continue;
        const key = logical(entry.Key);
        if (!key) continue;
        keys.push({
          key,
          size: entry.Size ?? 0,
          updatedAt: entry.LastModified ?? new Date(0),
        });
      }
      return { keys, cursor: response.NextContinuationToken ?? null };
    },
    async headBucket() {
      await send(
        "head bucket",
        new HeadBucketCommand({ Bucket: options.bucket }),
      );
    },
    async listVersions(key): Promise<GatewayVersion[]> {
      const response = await send<{
        Versions?: Array<{ Key?: string; VersionId?: string }>;
        DeleteMarkers?: Array<{ Key?: string; VersionId?: string }>;
      }>(
        "list versions",
        new ListObjectVersionsCommand({
          Bucket: options.bucket,
          Prefix: real(key),
        }),
      );
      const target = real(key);
      return [
        ...(response.Versions ?? []).map((entry) => ({
          versionId: entry.VersionId ?? "null",
          isDeleteMarker: false,
          key: entry.Key,
        })),
        ...(response.DeleteMarkers ?? []).map((entry) => ({
          versionId: entry.VersionId ?? "null",
          isDeleteMarker: true,
          key: entry.Key,
        })),
      ]
        .filter((entry) => entry.key === target)
        .map(({ versionId, isDeleteMarker }) => ({
          versionId,
          isDeleteMarker,
        }));
    },
    async deleteVersion(key, versionId) {
      await send(
        "delete version",
        new DeleteObjectCommand({
          Bucket: options.bucket,
          Key: real(key),
          VersionId: versionId,
        }),
      );
    },
  };
}
