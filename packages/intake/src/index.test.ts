import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPrivateFilesystemBlobStore,
  normalizeTelegramUpdate,
  parseCsvImport,
  parseJsonImport,
  parseWhatsAppTextExport,
} from "./index.js";

const context = {
  organizationId: "org-a",
  importerIdentity: "staff-import-1",
  authorByExternalIdentity: { Alice: "member-a", Bob: null },
  timezone: "America/Los_Angeles",
  receivedAt: "2026-11-08T12:00:00.000Z",
};
const mapping = {
  externalId: "id",
  author: "author",
  text: "text",
  timestamp: "sent",
};

describe("intake normalization", () => {
  it("accepts quoted multiline CSV and preserves duplicate rows for review", () => {
    const input =
      'id,author,text,sent\n1,Alice,"line one\nline two",2026-11-07\n2,Alice,"line one\nline two",2026-11-07\n';
    const parsed = parseCsvImport(input, context, {
      mapping,
      dateFormat: "YYYY-MM-DD",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.sources).toHaveLength(2);
    expect(parsed.sources[0]?.text).toBe("line one\nline two");
    expect(parsed.ambiguousDuplicates).toHaveLength(1);
    expect(
      parseCsvImport(input, context, {
        mapping,
        dateFormat: "YYYY-MM-DD",
      }).sources.map((s) => s.idempotencyKey),
    ).toEqual(parsed.sources.map((s) => s.idempotencyKey));
  });

  it("uses a selected date order and reports unmapped authors row by row", () => {
    const input =
      '[{"id":"x","author":"Alice","text":"hello","sent":"07/08/2026"},{"id":"y","author":"Eve","text":"hello","sent":"2026-07-08"}]';
    const result = parseJsonImport(input, context, {
      mapping,
      dateFormat: "MM/DD/YYYY",
    });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.occurredAt).toBe("2026-07-08T07:00:00.000Z");
    expect(result.errors.map((e) => e.code)).toEqual(["unmapped_author"]);
  });

  it("honors the caller-selected interpretation of ambiguous slash dates", () => {
    const input =
      '[{"id":"x","author":"Alice","text":"hello","sent":"01/02/2026"}]';
    const us = parseJsonImport(input, context, {
      mapping,
      dateFormat: "MM/DD/YYYY",
    });
    const eu = parseJsonImport(input, context, {
      mapping,
      dateFormat: "DD/MM/YYYY",
    });
    expect(us.sources[0]?.occurredAt).toBe("2026-01-02T08:00:00.000Z");
    expect(eu.sources[0]?.occurredAt).toBe("2026-02-01T08:00:00.000Z");
    expect(us.errors).toEqual([]);
    expect(eu.errors).toEqual([]);
  });

  it("parses WhatsApp continuation lines in a caller-selected timezone and keeps identity stable", () => {
    const input = "12/31/2024, 3:04 PM - Alice: hello\ncontinued";
    const result = parseWhatsAppTextExport(input, context, {
      dateOrder: "MDY",
      receivedAt: context.receivedAt,
    });
    expect(result.sources[0]?.occurredAt).toBe("2024-12-31T23:04:00.000Z");
    expect(result.sources[0]?.text).toBe("hello\ncontinued");
    expect(result.sources[0]?.original.payload).toContain(
      "12/31/2024, 3:04 PM - Alice: hello",
    );
    expect(result.sources[0]?.idempotencyKey).toBe(
      parseWhatsAppTextExport(input, context, {
        dateOrder: "MDY",
        receivedAt: context.receivedAt,
      }).sources[0]?.idempotencyKey,
    );
  });

  it("keeps WhatsApp repeated identical messages as distinct reviewable rows", () => {
    const input =
      "12/31/2024, 3:04 PM - Alice: hello\n12/31/2024, 3:04 PM - Alice: hello";
    const result = parseWhatsAppTextExport(input, context, {
      dateOrder: "MDY",
      receivedAt: context.receivedAt,
    });
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]?.sourceId).not.toBe(result.sources[1]?.sourceId);
    expect(result.ambiguousDuplicates).toHaveLength(1);
  });

  it("normalizes Telegram photo-only and edited updates with stable source identity", () => {
    const base = {
      update_id: 12,
      message: {
        message_id: 7,
        date: 1_700_000_000,
        chat: { id: -55 },
        from: { id: 9 },
        photo: [{ file_id: "opaque" }],
      },
    };
    const first = normalizeTelegramUpdate(base, {
      organizationId: "org-a",
      membershipId: null,
      timezone: "UTC",
      receivedAt: context.receivedAt,
    });
    expect(first?.text).toBe("");
    expect(first?.sourceId).toBe(
      normalizeTelegramUpdate(base, {
        organizationId: "org-a",
        membershipId: null,
        timezone: "UTC",
        receivedAt: context.receivedAt,
      })?.sourceId,
    );
    const edited = normalizeTelegramUpdate(
      {
        update_id: 13,
        edited_message: {
          ...base.message,
          edit_date: 1_700_000_100,
          text: "edited",
        },
      },
      {
        organizationId: "org-a",
        membershipId: null,
        timezone: "UTC",
        receivedAt: context.receivedAt,
      },
    );
    expect(edited?.revision).toBe(2);
    expect(edited?.replacesRevision).toBe(1);
    expect(edited?.sourceId).toBe(first?.sourceId);
  });

  it("uses trusted prior Telegram revisions for successive edits and deduplicates update IDs", () => {
    const sourceContext = {
      organizationId: "org-a",
      membershipId: null,
      timezone: "UTC",
      receivedAt: context.receivedAt,
    };
    const update = (update_id: number, edit_date: number, text: string) =>
      normalizeTelegramUpdate(
        {
          update_id,
          edited_message: {
            message_id: 7,
            date: 1_700_000_000,
            edit_date,
            chat: { id: -55 },
            text,
          },
        },
        sourceContext,
      );
    const second = update(13, 1_700_000_100, "edit 1");
    const replay = update(13, 1_700_000_100, "edit 1");
    const third = normalizeTelegramUpdate(
      {
        update_id: 14,
        edited_message: {
          message_id: 7,
          date: 1_700_000_000,
          edit_date: 1_700_000_200,
          chat: { id: -55 },
          text: "edit 2",
        },
      },
      { ...sourceContext, previousRevision: 2 },
    );
    expect(second?.revision).toBe(2);
    expect(third?.revision).toBe(3);
    expect(third?.replacesRevision).toBe(2);
    expect(second?.sourceId).toBe(third?.sourceId);
    expect(second?.idempotencyKey).toBe(replay?.idempotencyKey);
    expect(second?.idempotencyKey).not.toBe(third?.idempotencyKey);
  });

  it("writes only bounded image content and rejects fake MIME or escaped roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-blob-"));
    try {
      const store = createPrivateFilesystemBlobStore(join(root, "private"), {
        maxBytes: 64,
      });
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
      const saved = await store.put(png);
      expect(saved.mimeType).toBe("image/png");
      expect(saved.bytes).toBe(png.length);
      expect(await readFile(join(root, "private", saved.storageKey))).toEqual(
        png,
      );
      await expect(
        store.put(Buffer.from("not actually a png")),
      ).rejects.toThrow("Unsupported image");
      await expect(store.put(Buffer.alloc(65, 1))).rejects.toThrow("size");
      await symlink(root, join(root, "escape"));
      await expect(
        createPrivateFilesystemBlobStore(join(root, "escape")).put(png),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
