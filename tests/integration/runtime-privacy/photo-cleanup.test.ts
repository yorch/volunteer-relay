import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createProductExtensions } from "../../../apps/web/lib/product/extensions.ts";
import { createProductHandler } from "../../../apps/web/lib/product/http.ts";
import { createFilesystemBlobStore } from "../../../packages/blob/src/index.ts";
import {
  createAttachmentMetadataStore,
  createProcessingRepository,
  createSourceStore,
  sql,
} from "../../../packages/db/src/index.ts";
import { createAttachmentReader } from "../../../packages/domain/core/src/index.ts";
import { createSourceRepository } from "../../../packages/domain/core/src/sources/index.ts";
import { readPrivateBlob } from "../../../packages/intake/src/index.ts";
import { context, openDomainFixture } from "../domain/domain-support.ts";

const sharp: typeof import("../../../apps/web/node_modules/sharp/lib/index.js") =
  createRequire(new URL("../../../apps/web/package.json", import.meta.url))(
    "sharp",
  );

it("keeps the accepted photo and removes unreferenced bytes after a conflicting retry", async () => {
  const fixture = await openDomainFixture();
  const root = await mkdtemp(join(tmpdir(), "relay-photo-retry-"));
  try {
    const staff = await context(
      fixture.authorization,
      "user-kai",
      "tidepath",
      "photo",
    );
    const reader = await context(
      fixture.authorization,
      "user-ren",
      "tidepath",
      "reader",
    );
    const sources = createSourceRepository({
      authorization: fixture.authorization,
      store: createSourceStore(fixture.db),
    });
    const processing = createProcessingRepository(fixture.db);
    const attachments = createAttachmentReader({
      authorization: fixture.authorization,
      metadata: createAttachmentMetadataStore(fixture.db),
      blobs: { read: (key) => createFilesystemBlobStore({ root }).read(key) },
    });
    const extension = createProductExtensions({
      db: fixture.db,
      authorization: fixture.authorization,
      sources,
      processing,
      attachments,
      store: createFilesystemBlobStore({ root }),
      maxBytes: 1048576,
    });
    const handler = createProductHandler({
      appUrl: "http://localhost:3000",
      authorization: fixture.authorization,
      sources,
      processing,
      ledger: fixture.ledger,
      needs: fixture.needs,
      members: async () => [],
      extensions: extension,
      resolve: async (request) => {
        const selected =
          request.headers.get("x-test-role") === "reader" ? reader : staff;
        if (selected.actor.kind !== "user") throw new Error("Expected user");
        return {
          ok: true,
          value: {
            context: selected,
            organization: {
              organizationId: "tidepath",
              membershipId: selected.actor.membershipId,
              role: selected.actor.role,
              name: "Tidepath",
              slug: "tidepath",
            },
          },
        };
      },
    });
    const red = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const blue = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    const upload = (bytes: Buffer, role = "staff") => {
      const form = new FormData();
      form.set(
        "file",
        new File([new Uint8Array(bytes).buffer], "synthetic.png", {
          type: "image/png",
        }),
      );
      form.set("text", "Synthetic delivery");
      form.set("idempotencyKey", "same-key");
      return handler(
        new Request("http://localhost:3000/api/product/source-photo", {
          method: "POST",
          headers: { origin: "http://localhost:3000", "x-test-role": role },
          body: form,
        }),
      );
    };
    const first = await upload(red);
    expect(first.status).toBe(200);
    const receipt = (await first.json()) as { value: { sourceId: string } };
    const stored = await processing.getSource(staff, receipt.value.sourceId);
    if (!stored.ok || !stored.value.attachments[0])
      throw new Error("Missing accepted photo");
    const key = stored.value.attachments[0].storageKey;
    const before = await readPrivateBlob(root, key);
    expect(before).not.toBeNull();
    expect((await upload(blue)).status).toBe(409);
    expect(await readPrivateBlob(root, key)).toEqual(before);
    const rows = await fixture.db.execute(
      sql`select storage_key from source_attachment_identity where organization_id='tidepath'`,
    );
    expect(rows.rows).toEqual([{ storage_key: key }]);
    const dirs = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const dir of dirs)
      if (dir.isDirectory() && dir.name !== ".pending")
        for (const name of await readdir(join(root, dir.name)))
          files.push(`${dir.name}/${name}`);
    expect(files).toEqual([key]);
    expect(await readdir(join(root, ".pending"))).toEqual([]);
    expect((await upload(blue, "reader")).status).toBe(403);
    expect(await readdir(join(root, ".pending"))).toEqual([]);
    expect(await readPrivateBlob(root, key)).toEqual(before);
    const importPhoto = (bytes: Buffer, text: string) => {
      const form = new FormData();
      form.set(
        "data",
        JSON.stringify({
          format: "json",
          dateFormat: "ISO",
          timezone: "UTC",
          authorMapping: { Mira: "tidepath-mira" },
          photoMapping: { "import-row": ["synthetic.png"] },
          text: JSON.stringify([
            {
              id: "import-row",
              author: "Mira",
              text,
              timestamp: "2026-01-01T00:00:00Z",
            },
          ]),
        }),
      );
      form.append(
        "files",
        new File([new Uint8Array(bytes).buffer], "synthetic.png", {
          type: "image/png",
        }),
      );
      return handler(
        new Request("http://localhost:3000/api/product/import", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
          body: form,
        }),
      );
    };
    expect((await importPhoto(red, "Original import")).status).toBe(200);
    expect((await importPhoto(blue, "Changed import")).status).toBe(409);
    const after = await fixture.db.execute(
      sql`select distinct storage_key from source_attachment_identity where organization_id='tidepath'`,
    );
    expect(after.rows).toEqual([{ storage_key: key }]);
    const finalDirs = await readdir(root, { withFileTypes: true });
    const finalFiles: string[] = [];
    for (const dir of finalDirs)
      if (dir.isDirectory() && dir.name !== ".pending")
        for (const name of await readdir(join(root, dir.name)))
          finalFiles.push(`${dir.name}/${name}`);
    expect(finalFiles).toEqual([key]);
    expect(await readdir(join(root, ".pending"))).toEqual([]);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
