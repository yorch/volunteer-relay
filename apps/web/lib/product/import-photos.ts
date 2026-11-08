import { createHash } from "node:crypto";
import {
  type BlobWrite,
  detectedImageMime,
  type ImportPreview,
} from "@relay/intake";
import sharp from "sharp";

const MAX_INPUT = 5 * 1024 * 1024;
const MAX_FILES = 10;
function validName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/]/.test(name) &&
    !Array.from(name).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
async function bodyBytes(request: Request, limit: number): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing import body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw new Error("Import body exceeds limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
function parseInput(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_INPUT)
    throw new Error("Import data exceeds limit");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Invalid import data");
  return parsed as Record<string, unknown>;
}
export async function readImportInput(
  request: Request,
  maxImageBytes: number,
): Promise<{ input: Record<string, unknown>; files: Map<string, File> }> {
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1)
    throw new Error("Invalid image limit");
  const type = request.headers.get("content-type") ?? "";
  if (type.split(";")[0]?.trim().toLowerCase() === "application/json")
    return {
      input: parseInput((await bodyBytes(request, MAX_INPUT)).toString("utf8")),
      files: new Map(),
    };
  if (!/^multipart\/form-data\s*;/i.test(type))
    throw new Error("Unsupported import content type");
  const limit = MAX_FILES * maxImageBytes + MAX_INPUT;
  if (!Number.isSafeInteger(limit)) throw new Error("Invalid image limit");
  const body = await bodyBytes(request, limit);
  const form = await new Response(new Uint8Array(body).buffer, {
    headers: { "content-type": type },
  }).formData();
  const data = form.getAll("data");
  if (data.length !== 1 || typeof data[0] !== "string")
    throw new Error("Expected one import data field");
  const files = new Map<string, File>();
  let count = 0;
  for (const [key, value] of form.entries()) {
    if (key === "data") continue;
    if (key !== "files" || !(value instanceof File))
      throw new Error("Invalid import field");
    if (
      ++count > MAX_FILES ||
      !validName(value.name) ||
      value.size === 0 ||
      value.size > maxImageBytes
    )
      throw new Error("Invalid import image");
    const previous = files.get(value.name);
    if (previous) {
      if (
        !Buffer.from(await previous.arrayBuffer()).equals(
          Buffer.from(await value.arrayBuffer()),
        )
      )
        throw new Error("Conflicting image filenames");
    } else files.set(value.name, value);
  }
  return { input: parseInput(data[0]), files };
}

// CSV parsers preserve each original row as a JSON array, so only the header
// is needed here. Handle quoted commas and escaped quotes in that header.
function csvHeader(text: string): string[] | null {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "," || c === "\r" || c === "\n")) {
      fields.push(field.trim());
      field = "";
      if (c !== ",") return fields;
    } else field += c;
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields;
}
function references(value: unknown): string[] | null {
  if (typeof value === "string")
    return value === "" ? [] : value.split("|").map((v) => v.trim());
  if (Array.isArray(value) && value.every((v) => typeof v === "string"))
    return value as string[];
  return null;
}
export async function prepareImportPhotos(
  preview: ImportPreview,
  input: Record<string, unknown>,
  files: Map<string, File>,
  organizationId: string,
  maxBytes: number,
): Promise<{
  preview: ImportPreview;
  blobs: Array<{ metadata: BlobWrite; content: Uint8Array }>;
}> {
  const result: ImportPreview = structuredClone(preview);
  const blobs = new Map<string, { metadata: BlobWrite; content: Uint8Array }>();
  const decoded = new Map<
    string,
    { metadata: BlobWrite; content: Uint8Array }
  >();
  const used = new Set<string>();
  const issue = (row: number, code: string, message: string) =>
    result.errors.push({ row, code, message });
  if (
    files.size > MAX_FILES ||
    [...files].some(([name, file]) => !validName(name) || name !== file.name)
  ) {
    issue(0, "invalid_photo_upload", "Uploaded photo names are invalid");
    return { preview: result, blobs: [] };
  }
  const explicit = Object.hasOwn(input, "photoMapping");
  const mapping = input.photoMapping;
  if (
    explicit &&
    (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
  ) {
    issue(0, "invalid_photo_mapping", "Photo mapping must be an object");
    return { preview: result, blobs: [] };
  }
  const map = explicit ? (mapping as Record<string, unknown>) : {};
  const known = new Set(
    result.sources.map((source) => source.externalMessageId),
  );
  for (const key of Object.keys(map))
    if (!known.has(key))
      issue(0, "unknown_photo_row", "Photo mapping references an unknown row");
  const header =
    input.format === "csv" && typeof input.text === "string"
      ? csvHeader(input.text)
      : null;
  const photoColumn = header?.indexOf("photos") ?? -1;
  for (const [index, source] of result.sources.entries()) {
    const row = index + (input.format === "csv" ? 2 : 1);
    if (
      source.organizationId !== organizationId ||
      source.attachments.length !== 0
    ) {
      issue(row, "invalid_photo_source", "Import source is invalid");
      continue;
    }
    let value: unknown;
    if (explicit)
      value = Object.hasOwn(map, source.externalMessageId)
        ? map[source.externalMessageId]
        : undefined;
    else if (input.format === "json" || input.format === "csv") {
      try {
        const original: unknown = JSON.parse(source.original.payload);
        if (
          input.format === "json" &&
          original &&
          typeof original === "object" &&
          !Array.isArray(original)
        )
          value = (original as Record<string, unknown>).photos;
        if (
          input.format === "csv" &&
          photoColumn >= 0 &&
          Array.isArray(original)
        )
          value = original[photoColumn];
      } catch {
        issue(row, "invalid_photo_row", "Cannot read photo references");
        continue;
      }
    }
    if (value === undefined) continue;
    const names = references(value);
    if (
      !names ||
      (explicit && !Array.isArray(value)) ||
      names.length > MAX_FILES ||
      names.some((name) => !validName(name)) ||
      new Set(names).size !== names.length
    ) {
      issue(row, "invalid_photo_reference", "Photo references are invalid");
      continue;
    }
    for (const name of [...names].sort()) {
      const file = files.get(name);
      if (!file) {
        issue(row, "missing_photo", "A referenced photo was not uploaded");
        continue;
      }
      used.add(name);
      let blob = decoded.get(name);
      if (!blob) {
        try {
          if (
            !Number.isSafeInteger(maxBytes) ||
            maxBytes < 1 ||
            file.size === 0 ||
            file.size > maxBytes
          )
            throw new Error("size");
          const bytes = Buffer.from(await file.arrayBuffer());
          if (!detectedImageMime(bytes)) throw new Error("type");
          const output = await sharp(bytes, {
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
          if (output.length > maxBytes) throw new Error("size");
          const hash = createHash("sha256").update(output).digest("hex");
          blob = {
            metadata: {
              storageKey: `${hash.slice(0, 2)}/${hash}`,
              sha256: hash,
              mimeType: "image/png",
              bytes: output.length,
            },
            content: output,
          };
          decoded.set(name, blob);
        } catch {
          issue(row, "invalid_photo", "Photo is invalid or exceeds limits");
          continue;
        }
      }
      blobs.set(blob.metadata.sha256, blob);
      if (
        !source.attachments.some(
          (attachment) => attachment.sha256 === blob?.metadata.sha256,
        )
      )
        source.attachments.push({
          ...blob.metadata,
          id: `photo:${blob.metadata.sha256}`,
          organizationId,
        });
    }
  }
  for (const name of files.keys())
    if (!used.has(name))
      issue(0, "unmapped_photo", "An uploaded photo is not mapped to a row");
  return {
    preview: result,
    blobs: [...blobs.values()].sort((a, b) =>
      a.metadata.sha256.localeCompare(b.metadata.sha256),
    ),
  };
}
