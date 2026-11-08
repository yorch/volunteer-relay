import { createHash } from "node:crypto";
import type { BlobWrite, PrivateBlobStore } from "@relay/blob";
import { detectedImageMime } from "@relay/blob";
import type { SourceEnvelope, TenantContext } from "@relay/contracts";

/**
 * A photo failure that will not change on retry (unsupported, too large,
 * undecodable) is permanent; network/provider failures are transient.
 */
export class TelegramPhotoError extends Error {
  readonly permanent: boolean;
  constructor(permanent: boolean, message: string) {
    super(message);
    this.name = "TelegramPhotoError";
    this.permanent = permanent;
  }
}
export const isPermanentPhotoFailure = (error: unknown): boolean =>
  error instanceof TelegramPhotoError && error.permanent;

/** Decoded, metadata-stripped pixels ready to store; no database work yet. */
export type PreparedTelegramPhoto = {
  fileId: string;
  pixels: Uint8Array;
  storageKey: string;
  sha256: string;
};

/** Structural subset of the sharp API used by the shared photo pipeline. */
export interface PhotoPipeline {
  rotate(): PhotoPipeline;
  resize(options: {
    width: number;
    height: number;
    fit: "inside";
    withoutEnlargement: boolean;
  }): PhotoPipeline;
  png(): PhotoPipeline;
  toBuffer(): Promise<Buffer>;
}
export type PhotoDecoder = (
  input: Buffer,
  options: { limitInputPixels: number; failOn: "warning"; animated: boolean },
) => PhotoPipeline;

/**
 * The one decode/strip/resize pipeline used for every stored photo: a single
 * frame, auto-oriented, bounded to 2000px and re-encoded as PNG.
 */
export function createPhotoTransform(decode: PhotoDecoder) {
  return async (bytes: Uint8Array): Promise<Buffer> =>
    decode(Buffer.from(bytes), {
      limitInputPixels: 40000000,
      failOn: "warning",
      animated: false,
    })
      .rotate()
      .resize({
        width: 2000,
        height: 2000,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
}

const transientStatus = (status: number) => status === 429 || status >= 500;

/** Only prescribed Bot API photo endpoints are fetched; caller decodes/strips metadata. */
export function createTelegramPhotoDownloader(options: {
  botToken: string;
  maxBytes: number;
  transform: (bytes: Uint8Array) => Promise<Uint8Array>;
  fetch?: typeof fetch;
}) {
  const request = options.fetch ?? fetch;
  const unavailable = () => new TelegramPhotoError(false, "Photo unavailable");
  return async (fileId: string): Promise<PreparedTelegramPhoto> => {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(fileId))
      throw new TelegramPhotoError(true, "Invalid photo");
    let response: Response;
    try {
      response = await request(
        `https://api.telegram.org/bot${options.botToken}/getFile`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_id: fileId }),
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw unavailable();
    }
    // Bot API answers 400 for a file it will never serve (e.g. too big).
    if (!response.ok)
      throw new TelegramPhotoError(
        !transientStatus(response.status),
        "Photo unavailable",
      );
    let result: {
      ok?: boolean;
      result?: { file_path?: string; file_size?: number };
    };
    try {
      result = (await response.json()) as typeof result;
    } catch {
      throw unavailable();
    }
    const path = result.result?.file_path;
    if (!result.ok || !path || !/^photos\/[A-Za-z0-9_.-]+$/.test(path))
      throw new TelegramPhotoError(true, "Photo unavailable");
    if (!result.result?.file_size || result.result.file_size > options.maxBytes)
      throw new TelegramPhotoError(true, "Photo too large");
    let file: Response;
    try {
      file = await request(
        `https://api.telegram.org/file/bot${options.botToken}/${path}`,
        { signal: AbortSignal.timeout(20000) },
      );
    } catch {
      throw unavailable();
    }
    if (!file.ok || !file.body)
      throw new TelegramPhotoError(
        file.ok ? false : !transientStatus(file.status),
        "Photo unavailable",
      );
    const reader = file.body.getReader(),
      chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try {
          part = await reader.read();
        } catch {
          throw unavailable();
        }
        if (part.done) break;
        count += part.value.byteLength;
        if (count > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TelegramPhotoError(true, "Photo too large");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks);
    if (!detectedImageMime(raw))
      throw new TelegramPhotoError(true, "Unsupported image");
    let pixels: Uint8Array;
    try {
      pixels = await options.transform(raw);
    } catch {
      // Decoder warnings and pixel limits are properties of the file itself.
      throw new TelegramPhotoError(true, "Unsupported image");
    }
    const sha256 = createHash("sha256").update(pixels).digest("hex");
    return {
      fileId,
      pixels,
      sha256,
      storageKey: `${sha256.slice(0, 2)}/${sha256}`,
    };
  };
}

/** Stores prepared pixels; the only part of photo ingress that needs a lock. */
export async function storeTelegramPhoto(
  prepared: PreparedTelegramPhoto,
  context: TenantContext,
  store: PrivateBlobStore,
  withBlobLock?: (
    key: string,
    put: () => Promise<BlobWrite>,
  ) => Promise<BlobWrite>,
): Promise<SourceEnvelope["attachments"][number]> {
  const put = () => store.put(prepared.pixels);
  const blob = withBlobLock
    ? await withBlobLock(prepared.storageKey, put)
    : await put();
  return {
    ...blob,
    organizationId: context.organizationId,
    id: `telegram-photo:${createHash("sha256").update(prepared.fileId).digest("hex")}`,
  };
}

/** Download and store in one step (callers without a transaction boundary). */
export function createTelegramPhotoLoader(options: {
  botToken: string;
  store: PrivateBlobStore;
  maxBytes: number;
  transform: (bytes: Uint8Array) => Promise<Uint8Array>;
  fetch?: typeof fetch;
  withBlobLock?: (
    key: string,
    put: () => Promise<BlobWrite>,
  ) => Promise<BlobWrite>;
}) {
  const download = createTelegramPhotoDownloader(options);
  return async (
    fileId: string,
    context: TenantContext,
  ): Promise<SourceEnvelope["attachments"][number]> =>
    storeTelegramPhoto(
      await download(fileId),
      context,
      options.store,
      options.withBlobLock,
    );
}
