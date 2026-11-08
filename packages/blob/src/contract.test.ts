import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobError, type PrivateBlobStore } from "./contracts.ts";
import { createFilesystemBlobStore } from "./filesystem.ts";
import { createS3BlobStore } from "./s3.ts";
import { createFakeS3Gateway } from "./testing/fake-gateway.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const digestOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const keyOf = (bytes: Uint8Array) => {
  const digest = digestOf(bytes);
  return `${digest.slice(0, 2)}/${digest}`;
};

const backends: Array<{
  name: string;
  create: () => Promise<{
    store: PrivateBlobStore;
    dispose: () => Promise<void>;
  }>;
}> = [
  {
    name: "filesystem",
    create: async () => {
      // The adapter refuses a symlinked root; macOS tmpdir is one.
      const root = await realpath(
        await mkdtemp(join(tmpdir(), "relay-blob-contract-")),
      );
      return {
        store: createFilesystemBlobStore({ root, maxBytes: 1024 }),
        dispose: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "s3",
    create: async () => ({
      store: createS3BlobStore({
        gateway: createFakeS3Gateway(),
        deploymentId: "deployment-a",
        maxBytes: 1024,
      }),
      dispose: () => Promise.resolve(),
    }),
  },
];

describe.each(backends)("$name blob store", ({ create }) => {
  let current: Awaited<ReturnType<typeof create>> | undefined;
  afterEach(async () => {
    await current?.dispose();
    current = undefined;
  });
  const open = async () => {
    current = await create();
    return current.store;
  };

  it("round-trips digest-keyed bytes and reports the sniffed type", async () => {
    const store = await open();
    const write = await store.put(png);
    expect(write.storageKey).toBe(keyOf(png));
    expect(write.sha256).toBe(digestOf(png));
    expect(write.mimeType).toBe("image/png");
    expect(write.bytes).toBe(png.length);
    expect(await store.read(write.storageKey)).toEqual(new Uint8Array(png));
    // Replay of identical content is idempotent.
    expect((await store.put(png)).storageKey).toBe(write.storageKey);
  });

  it("rejects oversized and unsupported content before writing", async () => {
    const store = await open();
    await expect(store.put(Buffer.alloc(1025, 7))).rejects.toThrow("size");
    await expect(store.put(Buffer.from("not an image"))).rejects.toThrow(
      "Unsupported",
    );
  });

  it("returns null for absent and malformed keys", async () => {
    const store = await open();
    await expect(store.read(`aa/${"a".repeat(64)}`)).resolves.toBeNull();
    await expect(store.read("../../etc/passwd")).resolves.toBeNull();
    await expect(store.read("aa/short")).resolves.toBeNull();
  });

  it("erases idempotently and rejects a mismatched identity", async () => {
    const store = await open();
    const write = await store.put(png);
    await store.erase(write.storageKey, write.sha256);
    expect(await store.read(write.storageKey)).toBeNull();
    await store.erase(write.storageKey, write.sha256);
    await expect(
      store.erase(write.storageKey, "b".repeat(64)),
    ).rejects.toBeInstanceOf(BlobError);
  });

  it("reports capacity and probes without throwing", async () => {
    const store = await open();
    await store.probe();
    const capacity = await store.capacity();
    if (store.backend === "s3") expect(capacity.availableBytes).toBeNull();
    else expect(typeof capacity.availableBytes).toBe("number");
  });

  it("enumerates stored blobs with a resumable cursor", async () => {
    const store = await open();
    const first = await store.put(png);
    const second = await store.put(Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02]));
    const page = await store.lifecycle.scan(null, 1);
    const rest = page.cursor
      ? await store.lifecycle.scan(page.cursor, 10)
      : { entries: [] };
    const keys = [...page.entries, ...rest.entries].map((e) => e.storageKey);
    expect(new Set(keys)).toEqual(
      new Set([first.storageKey, second.storageKey]),
    );
  });
});
