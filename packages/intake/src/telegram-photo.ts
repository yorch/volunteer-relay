import { createHash } from "node:crypto";
import type { SourceEnvelope, TenantContext } from "@relay/contracts";
import {
  createPrivateFilesystemBlobStore,
  detectedImageMime,
} from "./index.ts";
/** Only prescribed Bot API photo endpoints are fetched; caller decodes/strips metadata. */
export function createTelegramPhotoLoader(options: {
  botToken: string;
  root: string;
  maxBytes: number;
  transform: (bytes: Uint8Array) => Promise<Uint8Array>;
  fetch?: typeof fetch;
  withBlobLock?: (
    key: string,
    put: () => Promise<import("./index.ts").BlobWrite>,
  ) => Promise<import("./index.ts").BlobWrite>;
}) {
  const request = options.fetch ?? fetch;
  return async (
    fileId: string,
    context: TenantContext,
  ): Promise<SourceEnvelope["attachments"][number]> => {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(fileId))
      throw new Error("Photo unavailable");
    const response = await request(
      `https://api.telegram.org/bot${options.botToken}/getFile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error("Photo unavailable");
    const result = (await response.json()) as {
      ok?: boolean;
      result?: { file_path?: string; file_size?: number };
    };
    const path = result.result?.file_path;
    if (
      !result.ok ||
      !path ||
      !/^photos\/[A-Za-z0-9_.-]+$/.test(path) ||
      !result.result?.file_size ||
      result.result.file_size > options.maxBytes
    )
      throw new Error("Photo unavailable");
    const file = await request(
      `https://api.telegram.org/file/bot${options.botToken}/${path}`,
      { signal: AbortSignal.timeout(20000) },
    );
    if (!file.ok || !file.body) throw new Error("Photo unavailable");
    const reader = file.body.getReader(),
      chunks: Uint8Array[] = [];
    let count = 0;
    try {
      for (;;) {
        const p = await reader.read();
        if (p.done) break;
        count += p.value.byteLength;
        if (count > options.maxBytes) {
          await reader.cancel();
          throw new Error("Photo too large");
        }
        chunks.push(p.value);
      }
    } finally {
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks);
    if (!detectedImageMime(raw)) throw new Error("Unsupported image");
    const pixels = await options.transform(raw);
    const digest = createHash("sha256").update(pixels).digest("hex");
    const key = `${digest.slice(0, 2)}/${digest}`;
    const put = () =>
      createPrivateFilesystemBlobStore(options.root, {
        maxBytes: options.maxBytes,
      }).put(pixels);
    const blob = options.withBlobLock
      ? await options.withBlobLock(key, put)
      : await put();
    return {
      ...blob,
      organizationId: context.organizationId,
      id: `telegram-photo:${createHash("sha256").update(fileId).digest("hex")}`,
    };
  };
}
