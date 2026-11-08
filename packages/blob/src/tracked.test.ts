import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { BlobIdentity } from "./contracts.ts";
import { createFilesystemBlobStore } from "./filesystem.ts";
import { withTrackedBlobWrites } from "./tracked.ts";

it("cleans failed writes and recovers a crash marker without losing referenced blobs", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "relay-write-recovery-")),
  );
  const store = createFilesystemBlobStore({ root });
  const content = Buffer.from("synthetic private bytes");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const identity: BlobIdentity = {
    storageKey: `${sha256.slice(0, 2)}/${sha256}`,
    sha256,
  };
  const write = async (note: (blob: BlobIdentity) => Promise<void>) => {
    await note(identity);
    await mkdir(join(root, sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(root, identity.storageKey), content);
  };
  const settle = async (blob: BlobIdentity, clear: () => Promise<void>) => {
    await store.erase(blob.storageKey, blob.sha256);
    await clear();
  };
  try {
    await expect(
      withTrackedBlobWrites(
        store,
        async (note) => {
          await write(note);
          throw new Error("transaction rejected");
        },
        settle,
      ),
    ).rejects.toThrow("transaction rejected");
    await expect(
      readFile(join(root, identity.storageKey)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(root, ".pending"))).toEqual([]);

    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await withTrackedBlobWrites(
      store,
      async (note) => write(note),
      async () => {
        throw new Error("database temporarily unavailable");
      },
    );
    log.mockRestore();
    expect(await readFile(join(root, identity.storageKey))).toEqual(content);
    expect(
      await store.lifecycle.recover(settle, { now: Date.now() + 7200000 }),
    ).toBe(1);
    await expect(
      readFile(join(root, identity.storageKey)),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // A successful settle without a reference keeps the bytes.
    await withTrackedBlobWrites(
      store,
      async (note) => write(note),
      async (_blob, clear) => {
        await clear();
      },
    );
    expect(await readFile(join(root, identity.storageKey))).toEqual(content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
