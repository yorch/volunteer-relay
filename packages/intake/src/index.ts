import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type SourceEnvelope, sourceEnvelopeSchema } from "@relay/contracts";

export type RowIssue = { row: number; code: string; message: string };
export type ImportPreview = {
  sources: SourceEnvelope[];
  errors: RowIssue[];
  ambiguousDuplicates: Array<{ sourceIds: string[]; rows: number[] }>;
};
export type TrustedImportContext = {
  organizationId: string;
  importerIdentity: string;
  authorByExternalIdentity: Readonly<Record<string, string | null>>;
  timezone: string;
  receivedAt: string;
  channelIdentity?: string;
};
export type ImportMapping = {
  externalId: string;
  author: string;
  text: string;
  timestamp?: string;
};

const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 10_000;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const stableId = (prefix: string, value: string) => `${prefix}_${hash(value)}`;
const iso = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function validContext(ctx: TrustedImportContext): string | null {
  if (
    !ctx.organizationId ||
    !ctx.importerIdentity ||
    !ctx.timezone ||
    !iso(ctx.receivedAt)
  )
    return "Invalid trusted import context";
  try {
    new Intl.DateTimeFormat("en", { timeZone: ctx.timezone });
  } catch {
    return "Unknown timezone";
  }
  return null;
}

function parseMappedDate(
  value: unknown,
  format?: "ISO" | "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY",
  timezone = "UTC",
): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim();
  if (!format || format === "ISO") {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(input)) return null;
    return iso(input);
  }
  const m = /^(\d{1,4})[-/](\d{1,2})[-/](\d{1,4})$/.exec(input);
  if (!m) return null;
  let year: number, month: number, day: number;
  if (format === "YYYY-MM-DD")
    [, year, month, day] = m.map(Number) as [number, number, number, number];
  else {
    const a = Number(m[1]),
      b = Number(m[2]),
      y = Number(m[3]);
    if (a <= 12 && b <= 12) return null;
    year = y;
    month = format === "MM/DD/YYYY" ? a : b;
    day = format === "MM/DD/YYYY" ? b : a;
  }
  if (year < 100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const local = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00`;
  return localDateTimeToInstant(local, timezone);
}

function assemble(
  rows: Array<{ data: Record<string, unknown>; row: number }>,
  ctx: TrustedImportContext,
  map: ImportMapping,
  dateFormat?: ImportOptions["dateFormat"],
): ImportPreview {
  const errors: RowIssue[] = [];
  const sources: SourceEnvelope[] = [];
  const collisionMap = new Map<string, Array<{ id: string; row: number }>>();
  const fingerprintCounts = new Map<string, number>();
  const contextIssue = validContext(ctx);
  if (contextIssue)
    return {
      sources,
      errors: [{ row: 0, code: "context", message: contextIssue }],
      ambiguousDuplicates: [],
    };
  if (rows.length > MAX_IMPORT_ROWS)
    return {
      sources,
      errors: [
        {
          row: 0,
          code: "row_limit",
          message: `Import exceeds ${MAX_IMPORT_ROWS} rows`,
        },
      ],
      ambiguousDuplicates: [],
    };
  for (const { data, row } of rows) {
    const idValue = data[map.externalId];
    const authorValue = data[map.author];
    const textValue = data[map.text];
    if (typeof textValue !== "string" || !textValue.trim()) {
      errors.push({
        row,
        code: "missing_text",
        message: "Message text is required",
      });
      continue;
    }
    if (typeof authorValue !== "string" || !authorValue.trim()) {
      errors.push({
        row,
        code: "missing_author",
        message: "Author mapping is required",
      });
      continue;
    }
    const author = ctx.authorByExternalIdentity[authorValue.trim()];
    if (author === undefined) {
      errors.push({
        row,
        code: "unmapped_author",
        message: `No trusted author mapping for ${authorValue}`,
      });
      continue;
    }
    const timestamp =
      map.timestamp && data[map.timestamp] !== undefined
        ? parseMappedDate(data[map.timestamp], dateFormat, ctx.timezone)
        : null;
    if (map.timestamp && data[map.timestamp] !== undefined && !timestamp) {
      errors.push({
        row,
        code: "invalid_timestamp",
        message:
          "Timestamp is invalid or ambiguous; choose an explicit date format",
      });
      continue;
    }
    // Missing provider IDs use a content fingerprint plus duplicate ordinal, keeping every row reviewable.
    const fingerprint = `${authorValue}\u0000${timestamp ?? ""}\u0000${textValue}`;
    const ordinal = fingerprintCounts.get(fingerprint) ?? 0;
    fingerprintCounts.set(fingerprint, ordinal + 1);
    const externalId =
      typeof idValue === "string" && idValue.trim()
        ? idValue.trim()
        : `row-${hash(`${fingerprint}\u0000${ordinal}`).slice(0, 24)}`;
    const channelIdentity =
      ctx.channelIdentity ?? stableId("import", ctx.importerIdentity);
    const idempotencyKey = stableId(
      "src",
      `${ctx.organizationId}\u0000import\u0000${channelIdentity}\u0000${externalId}`,
    );
    const payload =
      typeof data.__original === "string"
        ? data.__original
        : JSON.stringify(data);
    const candidate = {
      schemaVersion: 1 as const,
      organizationId: ctx.organizationId,
      sourceId: stableId("source", idempotencyKey),
      revision: 1,
      channel: "import" as const,
      channelIdentity,
      externalMessageId: externalId,
      idempotencyKey,
      author: { externalIdentity: authorValue.trim(), membershipId: author },
      occurredAt: timestamp,
      receivedAt: new Date(ctx.receivedAt).toISOString(),
      timezone: ctx.timezone,
      text: textValue,
      attachments: [],
      replyToSourceId: null,
      replacesRevision: null,
      original: { mediaType: "application/json", payload },
    };
    const checked = sourceEnvelopeSchema.safeParse(candidate);
    if (!checked.success) {
      errors.push({
        row,
        code: "invalid_source",
        message: "Mapped row does not satisfy source contract",
      });
      continue;
    }
    sources.push(checked.data);
    const sameKey = `key:${idempotencyKey}`;
    const sameContent = `body:${fingerprint}`;
    for (const key of [sameKey, sameContent]) {
      const group = collisionMap.get(key) ?? [];
      group.push({ id: checked.data.sourceId, row });
      collisionMap.set(key, group);
    }
  }
  const groups: ImportPreview["ambiguousDuplicates"] = [];
  for (const group of collisionMap.values())
    if (group.length > 1) {
      // Avoid emitting the exact same group twice when both key and content collide.
      if (
        !groups.some(
          (g) => g.sourceIds.join() === group.map((x) => x.id).join(),
        )
      )
        groups.push({
          sourceIds: group.map((x) => x.id),
          rows: group.map((x) => x.row),
        });
    }
  return { sources, errors, ambiguousDuplicates: groups };
}

export type ImportOptions = {
  mapping: ImportMapping;
  dateFormat?: "ISO" | "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY";
  maxBytes?: number;
};

function checkInput(input: string, maxBytes: number): string | null {
  return Buffer.byteLength(input, "utf8") > maxBytes
    ? `Import exceeds ${maxBytes} bytes`
    : null;
}

export function parseJsonImport(
  input: string,
  context: TrustedImportContext,
  options: ImportOptions,
): ImportPreview {
  const limit = options.maxBytes ?? MAX_TEXT_BYTES;
  const tooBig = checkInput(input, limit);
  if (tooBig)
    return {
      sources: [],
      errors: [{ row: 0, code: "size_limit", message: tooBig }],
      ambiguousDuplicates: [],
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return {
      sources: [],
      errors: [
        { row: 0, code: "invalid_json", message: "Input is not valid JSON" },
      ],
      ambiguousDuplicates: [],
    };
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" &&
        parsed !== null &&
        Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : null;
  if (!rows)
    return {
      sources: [],
      errors: [
        {
          row: 0,
          code: "unsupported_json",
          message:
            "Expected a JSON array or an object containing a messages array",
        },
      ],
      ambiguousDuplicates: [],
    };
  const valid = rows.flatMap((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return [];
    return [
      {
        data: {
          ...(value as Record<string, unknown>),
          __original: JSON.stringify(value),
        },
        row: index + 1,
      },
    ];
  });
  const result = assemble(valid, context, options.mapping, options.dateFormat);
  rows.forEach((value, i) => {
    if (
      (typeof value !== "object" || value === null || Array.isArray(value)) &&
      !result.errors.some((e) => e.row === i + 1)
    )
      result.errors.push({
        row: i + 1,
        code: "invalid_row",
        message: "Each message must be a JSON object",
      });
  });
  return result;
}

function parseCsvRows(input: string): { rows: string[][]; error?: string } {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.length === 0) quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) return { rows: [], error: "Unclosed quoted CSV field" };
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return { rows };
}

export function parseCsvImport(
  input: string,
  context: TrustedImportContext,
  options: ImportOptions,
): ImportPreview {
  const tooBig = checkInput(input, options.maxBytes ?? MAX_TEXT_BYTES);
  if (tooBig)
    return {
      sources: [],
      errors: [{ row: 0, code: "size_limit", message: tooBig }],
      ambiguousDuplicates: [],
    };
  const parsed = parseCsvRows(input);
  if (parsed.error)
    return {
      sources: [],
      errors: [{ row: 0, code: "malformed_csv", message: parsed.error }],
      ambiguousDuplicates: [],
    };
  if (parsed.rows.length < 2)
    return {
      sources: [],
      errors: [
        {
          row: 0,
          code: "missing_header",
          message: "CSV needs a header and at least one data row",
        },
      ],
      ambiguousDuplicates: [],
    };
  const headerRow = parsed.rows[0];
  if (!headerRow)
    return {
      sources: [],
      errors: [
        { row: 1, code: "missing_header", message: "CSV header is missing" },
      ],
      ambiguousDuplicates: [],
    };
  const header = headerRow.map((x) => x.trim());
  if (new Set(header).size !== header.length || header.some((x) => !x))
    return {
      sources: [],
      errors: [
        {
          row: 1,
          code: "invalid_header",
          message: "CSV headers must be nonempty and unique",
        },
      ],
      ambiguousDuplicates: [],
    };
  const rows: Array<{ data: Record<string, unknown>; row: number }> = [];
  const errors: RowIssue[] = [];
  parsed.rows.slice(1).forEach((fields, index) => {
    if (fields.length !== header.length) {
      errors.push({
        row: index + 2,
        code: "invalid_columns",
        message: "CSV row does not match the header width",
      });
      return;
    }
    rows.push({
      data: {
        ...Object.fromEntries(header.map((name, i) => [name, fields[i] ?? ""])),
        __original: JSON.stringify(fields),
      },
      row: index + 2,
    });
  });
  const result = assemble(rows, context, options.mapping, options.dateFormat);
  result.errors.unshift(...errors);
  return result;
}

/** Supported WhatsApp text export: `12/31/2024, 3:04 PM - Name: message`; locale is explicit. */
export function parseWhatsAppTextExport(
  input: string,
  context: TrustedImportContext,
  options: { dateOrder: "MDY" | "DMY"; receivedAt: string },
): ImportPreview {
  const tooBig = checkInput(input, MAX_TEXT_BYTES);
  if (tooBig)
    return {
      sources: [],
      errors: [{ row: 0, code: "size_limit", message: tooBig }],
      ambiguousDuplicates: [],
    };
  const lines = input.split(/\r?\n/);
  const rows: Array<{ data: Record<string, unknown>; row: number }> = [];
  const errors: RowIssue[] = [];
  const messageCounts = new Map<string, number>();
  const pattern =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}) (AM|PM) - ([^:]+): ([\s\S]*)$/;
  let current: {
    author: string;
    text: string;
    original: string;
    date: string;
    row: number;
  } | null = null;
  const commit = () => {
    if (current) {
      const fingerprint = `${current.author}\u0000${current.date}\u0000${current.text}`;
      const ordinal = messageCounts.get(fingerprint) ?? 0;
      messageCounts.set(fingerprint, ordinal + 1);
      rows.push({
        row: current.row,
        data: {
          export_id: `wa-${hash(fingerprint).slice(0, 24)}-${ordinal}`,
          author: current.author,
          text: current.text,
          timestamp: current.date,
          __original: current.original,
        },
      });
    }
  };
  lines.forEach((line, i) => {
    const m = pattern.exec(line);
    if (m) {
      commit();
      const a = Number(m[1]),
        b = Number(m[2]);
      if (
        (options.dateOrder === "MDY" && a > 12) ||
        (options.dateOrder === "DMY" && b > 12) ||
        Number(m[4]) < 1 ||
        Number(m[4]) > 12 ||
        Number(m[5]) > 59
      ) {
        errors.push({
          row: i + 1,
          code: "invalid_timestamp",
          message:
            "Date or time does not match the selected WhatsApp export format",
        });
        current = null;
        return;
      }
      const month = options.dateOrder === "MDY" ? a : b,
        day = options.dateOrder === "MDY" ? b : a;
      let hour = Number(m[4]) % 12;
      if (m[6] === "PM") hour += 12;
      const local = `${m[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${m[5]}:00`;
      const timestamp = localDateTimeToInstant(local, context.timezone);
      if (!timestamp) {
        errors.push({
          row: i + 1,
          code: "invalid_timestamp",
          message:
            "WhatsApp timestamp is invalid or ambiguous in the selected timezone",
        });
        current = null;
        return;
      }
      current = {
        author: m[7]?.trim() ?? "",
        text: m[8] ?? "",
        original: line,
        date: timestamp,
        row: i + 1,
      };
    } else if (current) {
      current.text += `\n${line}`;
      current.original += `\n${line}`;
    } else if (line.trim())
      errors.push({
        row: i + 1,
        code: "unsupported_line",
        message: "Line does not match the documented WhatsApp text format",
      });
  });
  commit();
  const result = assemble(
    rows,
    { ...context, receivedAt: options.receivedAt },
    {
      externalId: "export_id",
      author: "author",
      text: "text",
      timestamp: "timestamp",
    },
    "ISO",
  );
  result.errors.unshift(...errors);
  return result;
}

function localDateTimeToInstant(
  local: string,
  timezone: string,
): string | null {
  const base = new Date(`${local}Z`);
  if (Number.isNaN(base.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(base);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const utcFromZone = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  const diff = utcFromZone - base.getTime();
  const adjusted = new Date(base.getTime() - diff);
  const verify = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .format(adjusted)
    .replace(" ", "T");
  return verify === local ? adjusted.toISOString() : null;
}

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
export type TelegramMessage = {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number | string };
  from?: { id: number | string };
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  reply_to_message?: { message_id: number };
};

export function normalizeTelegramUpdate(
  update: TelegramUpdate,
  context: Omit<
    TrustedImportContext,
    "authorByExternalIdentity" | "importerIdentity"
  > & { membershipId: string | null },
): SourceEnvelope | null {
  if (
    !Number.isSafeInteger(update.update_id) ||
    !context.organizationId ||
    !context.timezone ||
    !iso(context.receivedAt)
  )
    return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: context.timezone });
  } catch {
    return null;
  }
  const message = update.edited_message ?? update.message;
  if (
    !message ||
    !Number.isSafeInteger(message.message_id) ||
    (!Number.isSafeInteger(message.chat?.id) &&
      typeof message.chat?.id !== "string")
  )
    return null;
  const chat = String(message.chat.id);
  const identity = `${chat}:${message.message_id}`;
  const changed = message.edit_date !== undefined;
  const occurredSeconds = changed ? message.edit_date : message.date;
  if (
    typeof occurredSeconds !== "number" ||
    !Number.isSafeInteger(occurredSeconds) ||
    occurredSeconds <= 0
  )
    return null;
  const externalMessageId = identity;
  const revision = changed ? 2 : 1;
  const idempotencyKey = stableId(
    "src",
    `${context.organizationId}\u0000telegram\u0000${identity}\u0000${revision}`,
  );
  const photos = Array.isArray(message.photo) ? message.photo : [];
  const candidate = {
    schemaVersion: 1 as const,
    organizationId: context.organizationId,
    sourceId: stableId(
      "source",
      `${context.organizationId}\u0000telegram\u0000${identity}`,
    ),
    revision,
    channel: "telegram" as const,
    channelIdentity: stableId("chat", chat),
    externalMessageId,
    idempotencyKey,
    author: {
      externalIdentity: message.from ? String(message.from.id) : `chat:${chat}`,
      membershipId: context.membershipId,
    },
    occurredAt: new Date(occurredSeconds * 1000).toISOString(),
    receivedAt: new Date(context.receivedAt).toISOString(),
    timezone: context.timezone,
    text: message.text ?? message.caption ?? "",
    attachments: [],
    replyToSourceId: message.reply_to_message
      ? stableId(
          "source",
          `${context.organizationId}\u0000telegram\u0000${chat}:${message.reply_to_message.message_id}`,
        )
      : null,
    replacesRevision: changed ? 1 : null,
    original: {
      mediaType: "application/json",
      payload: JSON.stringify({
        update_id: update.update_id,
        message: { ...message, photo: photos },
      }),
    },
  };
  const result = sourceEnvelopeSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

export type BlobWrite = {
  storageKey: string;
  sha256: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
};
const signatures: Array<{
  mime: BlobWrite["mimeType"];
  check: (b: Buffer) => boolean;
}> = [
  {
    mime: "image/png",
    check: (b) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  {
    mime: "image/jpeg",
    check: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: "image/webp",
    check: (b) =>
      b.length >= 12 &&
      b.toString("ascii", 0, 4) === "RIFF" &&
      b.toString("ascii", 8, 12) === "WEBP",
  },
];

export function createPrivateFilesystemBlobStore(
  rootPath: string,
  options: { maxBytes?: number } = {},
) {
  const root = resolve(rootPath);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  return {
    async put(bytes: Uint8Array): Promise<BlobWrite> {
      const data = Buffer.from(bytes);
      if (data.length === 0 || data.length > maxBytes)
        throw new Error("Attachment size is invalid");
      const detected = signatures.find((entry) => entry.check(data));
      if (!detected) throw new Error("Unsupported image content");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const actualRoot = await realpath(root);
      if (actualRoot !== root)
        throw new Error("Attachment root must not be a symlink");
      const digest = createHash("sha256").update(data).digest("hex");
      const storageKey = `${digest.slice(0, 2)}/${digest}`;
      const destination = resolve(root, storageKey);
      if (!destination.startsWith(`${root}${sep}`))
        throw new Error("Invalid storage key");
      await mkdir(join(root, digest.slice(0, 2)), {
        recursive: true,
        mode: 0o700,
      });
      const dir = await realpath(join(root, digest.slice(0, 2)));
      if (!dir.startsWith(`${root}${sep}`))
        throw new Error("Attachment directory escapes root");
      const tempPath = join(dir, `.${randomUUID()}.tmp`);
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(tempPath, destination);
      } catch (error) {
        await rm(tempPath, { force: true });
        try {
          const existing = await stat(destination);
          if (!existing.isFile() || existing.size !== data.length) throw error;
        } catch {
          throw error;
        }
      }
      return {
        storageKey,
        sha256: digest,
        mimeType: detected.mime,
        bytes: data.length,
      };
    },
  };
}
