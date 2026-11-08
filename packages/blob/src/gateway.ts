import { BlobError } from "./contracts.ts";

/**
 * Minimal gateway surface used by the adapter.
 *
 * Only lowest-common-denominator S3 operations are required, so S3-compatible
 * services that lack conditional writes, checksum headers or versioning still
 * work. Provider-specific capabilities are optional members.
 */
export interface GatewayObject {
  key: string;
  size: number;
  updatedAt: Date;
}

export interface GatewayPage {
  keys: GatewayObject[];
  cursor: string | null;
}

export interface GatewayVersion {
  versionId: string;
  isDeleteMarker: boolean;
}

export interface S3Gateway {
  put(
    key: string,
    body: Uint8Array,
    contentType: string,
    options?: { ifNoneMatch?: boolean },
  ): Promise<void>;
  /** Bounded read: null when absent, or larger than `limit`. */
  get(key: string, limit: number): Promise<Uint8Array | null>;
  head(key: string): Promise<GatewayObject | null>;
  delete(key: string): Promise<void>;
  list(cursor: string | null, limit: number): Promise<GatewayPage>;
  headBucket(): Promise<void>;
  listVersions(key: string): Promise<GatewayVersion[]>;
  deleteVersion(key: string, versionId: string): Promise<void>;
}

/** Maps a provider failure onto the shared taxonomy without leaking details. */
export function gatewayError(operation: string, error: unknown): BlobError {
  if (error instanceof BlobError) return error;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
  const name = (error as { name?: string } | null)?.name ?? "";
  if (status === 404 || name === "NotFound" || name === "NoSuchKey")
    return new BlobError("absent", `${operation} failed: absent`);
  if (status === 403 || name === "AccessDenied")
    return new BlobError("denied", `${operation} failed: denied`);
  if (status === 412 || status === 409 || name === "PreconditionFailed")
    return new BlobError("denied", `${operation} failed: precondition`);
  if (status === 507 || name === "InsufficientStorage")
    return new BlobError("quota", `${operation} failed: quota`);
  if (status === 503 || name === "SlowDown" || name === "ServiceUnavailable")
    return new BlobError("unavailable", `${operation} failed: throttled`);
  if (status === 400 || name === "InvalidRequest")
    return new BlobError("invalid", `${operation} failed: invalid request`);
  return new BlobError("unavailable", `${operation} failed: unavailable`);
}
