import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  prepareImportPhotos,
  readImportInput,
} from "../../../apps/web/lib/product/import-photos.ts";
import {
  parseCsvImport,
  parseJsonImport,
} from "../../../packages/intake/src/index.ts";

const sharp: typeof import("../../../apps/web/node_modules/sharp/lib/index.js") =
  createRequire(new URL("../../../apps/web/package.json", import.meta.url))(
    "sharp",
  );
const context = {
  organizationId: "org-a",
  importerIdentity: "staff",
  authorByExternalIdentity: { Mira: "mira" },
  timezone: "UTC",
  receivedAt: "2026-01-01T00:00:00Z",
};
const options = {
  mapping: { externalId: "id", author: "author", text: "text" },
};
const makeImage = async (color: string) =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "private-marker" } } })
    .toBuffer();
const file = (name: string, data: Uint8Array) =>
  new File([new Uint8Array(data).buffer], name, { type: "image/jpeg" });
const request = (form: FormData) =>
  new Request("http://localhost/import", { method: "POST", body: form });
const data = (format: string, text: string, photoMapping?: unknown) => ({
  format,
  text,
  ...(photoMapping === undefined ? {} : { photoMapping }),
});

describe("bounded import photo preparation", () => {
  it("parses JSON and multipart, rejecting conflicting names, unknown fields and excess data", async () => {
    const input = data("json", "[]");
    const json = new Request("http://localhost/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(await readImportInput(json, 10000)).toEqual({
      input,
      files: new Map(),
    });
    const red = await makeImage("red");
    const form = new FormData();
    form.set("data", JSON.stringify(input));
    form.append("files", file("box.jpg", red));
    form.append("files", file("box.jpg", red));
    expect((await readImportInput(request(form), 10000)).files.size).toBe(1);
    const conflict = new FormData();
    conflict.set("data", JSON.stringify(input));
    conflict.append("files", file("box.jpg", red));
    conflict.append("files", file("box.jpg", await makeImage("blue")));
    await expect(readImportInput(request(conflict), 10000)).rejects.toThrow();
    const many = new FormData();
    many.set("data", JSON.stringify(input));
    for (let i = 0; i < 11; i++) many.append("files", file(`${i}.jpg`, red));
    await expect(readImportInput(request(many), 10000)).rejects.toThrow();
    await expect(
      readImportInput(
        new Request("http://localhost/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "x".repeat(5 * 1024 * 1024 + 1),
        }),
        10000,
      ),
    ).rejects.toThrow();
  });
  it("strips metadata, scopes attachments and stays stable across filename ordering and replay", async () => {
    const original = await makeImage("red");
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const text = JSON.stringify([{ id: "one", author: "Mira", text: "Box" }]);
    const parsed = parseJsonImport(text, context, options);
    const files = new Map([
      ["a.jpg", file("a.jpg", original)],
      ["b.jpg", file("b.jpg", await makeImage("blue"))],
    ]);
    const one = await prepareImportPhotos(
      parsed,
      data("json", text, { one: ["a.jpg", "b.jpg"] }),
      files,
      "org-a",
      10000,
    );
    const two = await prepareImportPhotos(
      parsed,
      data("json", text, { one: ["b.jpg", "a.jpg"] }),
      files,
      "org-a",
      10000,
    );
    expect(one).toEqual(two);
    expect(one.preview.errors).toEqual([]);
    expect(parsed.sources[0]?.attachments).toEqual([]);
    expect(one.preview.sources[0]?.attachments).toHaveLength(2);
    for (const blob of one.blobs) {
      expect(blob.metadata).toMatchObject({
        mimeType: "image/png",
        bytes: blob.content.length,
      });
      expect((await sharp(blob.content).metadata()).exif).toBeUndefined();
      expect(
        Buffer.from(blob.content).includes(Buffer.from("private-marker")),
      ).toBe(false);
    }
    expect(
      one.preview.sources[0]?.attachments.every(
        (attachment) => attachment.organizationId === "org-a",
      ),
    ).toBe(true);
    const wrongTenant = await prepareImportPhotos(
      parsed,
      data("json", text, { one: ["a.jpg"] }),
      files,
      "org-b",
      10000,
    );
    expect(wrongTenant.preview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_photo_source" }),
      ]),
    );
    expect(wrongTenant.blobs).toEqual([]);
  });
  it("infers JSON and CSV references from preserved original rows", async () => {
    const img = file("box.jpg", await makeImage("red"));
    const files = new Map([[img.name, img]]);
    const json = JSON.stringify([
      { id: "one", author: "Mira", text: "Box", photos: ["box.jpg"] },
    ]);
    const a = await prepareImportPhotos(
      parseJsonImport(json, context, options),
      data("json", json),
      files,
      "org-a",
      10000,
    );
    expect(a.preview.errors).toEqual([]);
    expect(a.preview.sources[0]?.attachments).toHaveLength(1);
    const csv = "id,author,text,photos\none,Mira,Box,box.jpg\n";
    const b = await prepareImportPhotos(
      parseCsvImport(csv, context, options),
      data("csv", csv),
      files,
      "org-a",
      10000,
    );
    expect(b.preview.errors).toEqual([]);
    expect(b.preview.sources[0]?.attachments).toHaveLength(1);
  });
  it("blocks missing, malformed, unknown, unmapped and invalid images", async () => {
    const text = JSON.stringify([{ id: "one", author: "Mira", text: "Box" }]);
    const parsed = parseJsonImport(text, context, options);
    const bad = file("bad.jpg", Buffer.from("not an image"));
    const extra = file("extra.jpg", await makeImage("red"));
    const result = await prepareImportPhotos(
      parsed,
      data("json", text, {
        one: ["missing.jpg", "bad.jpg"],
        unknown: ["extra.jpg"],
      }),
      new Map([
        ["bad.jpg", bad],
        ["extra.jpg", extra],
      ]),
      "org-a",
      10000,
    );
    expect(result.preview.errors.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "unknown_photo_row",
        "missing_photo",
        "invalid_photo",
        "unmapped_photo",
      ]),
    );
    expect(result.blobs).toEqual([]);
    const malformed = await prepareImportPhotos(
      parsed,
      data("json", text, { one: "bad.jpg" }),
      new Map(),
      "org-a",
      10000,
    );
    expect(malformed.preview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_photo_reference" }),
      ]),
    );
  });
});
