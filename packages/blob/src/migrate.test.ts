import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BlobLifecycle, PrivateBlobStore } from "./contracts.ts";
import { createFilesystemBlobStore } from "./filesystem.ts";
import {
  isMigrationComplete,
  isValidLiveKey,
  type KeyOutcome,
  type LiveKey,
  migrateKey,
  runMigration,
} from "./migrate.ts";
import { createS3BlobStore } from "./s3.ts";
import { createFakeS3Gateway } from "./testing/fake-gateway.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 5, 5]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x60]);

function liveOf(bytes: Uint8Array): LiveKey {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    storageKey: `${sha256.slice(0, 2)}/${sha256}`,
    sha256,
    bytes: bytes.byteLength,
  };
}

function pair() {
  const sourceGateway = createFakeS3Gateway();
  const targetGateway = createFakeS3Gateway();
  return {
    sourceGateway,
    targetGateway,
    source: createS3BlobStore({
      gateway: sourceGateway,
      deploymentId: "deployment-a",
    }),
    target: createS3BlobStore({
      gateway: targetGateway,
      deploymentId: "deployment-a",
    }),
  };
}

async function* iterable<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

const noopLifecycle: BlobLifecycle = {
  async begin() {},
  async end() {},
  async scan() {
    return { entries: [], cursor: null };
  },
  async recover() {
    return 0;
  },
  async close() {},
};

function stubStore(overrides: Partial<PrivateBlobStore>): PrivateBlobStore {
  return {
    backend: "s3",
    lifecycle: noopLifecycle,
    async put() {
      throw new Error("not implemented");
    },
    async read() {
      return null;
    },
    async erase() {},
    async capacity() {
      return { availableBytes: null };
    },
    async probe() {},
    ...overrides,
  };
}

it("copies a live key and verifies both ends", async () => {
  const { source, target } = pair();
  const live = liveOf(png);
  await source.put(png);
  const summary = await runMigration({
    keys: iterable([live]),
    source,
    target,
    mode: "copy",
  });
  expect(summary).toMatchObject({
    live: 1,
    copied: 1,
    bytesCopied: png.length,
  });
  expect(await target.read(live.storageKey)).toEqual(new Uint8Array(png));
  expect(isMigrationComplete(summary)).toBe(true);
});

it("skips a key that is already complete in the target without reading the source", async () => {
  const { sourceGateway, source, target } = pair();
  const live = liveOf(png);
  await source.put(png);
  await target.put(png);
  sourceGateway.calls.length = 0;
  const outcome = await migrateKey(live, source, target, "copy");
  expect(outcome).toBe("alreadyPresent");
  expect(sourceGateway.calls).toEqual([]);
});

it("repairs a truncated target instead of trusting it", async () => {
  const { targetGateway, source, target } = pair();
  const live = liveOf(png);
  await source.put(png);
  targetGateway.objects.set(live.storageKey, {
    bytes: Uint8Array.from(png.subarray(0, 4)),
    contentType: "image/png",
    updatedAt: new Date(),
  });
  expect(await migrateKey(live, source, target, "copy")).toBe("copied");
  expect(await target.read(live.storageKey)).toEqual(new Uint8Array(png));
  // Verify mode cannot repair, so it must fail closed.
  targetGateway.objects.set(live.storageKey, {
    bytes: Uint8Array.from(png.subarray(0, 4)),
    contentType: "image/png",
    updatedAt: new Date(),
  });
  expect(await migrateKey(live, source, target, "verify")).toBe("missing");
});

it("reports a live key the source does not have", async () => {
  const { source, target } = pair();
  const summary = await runMigration({
    keys: iterable([liveOf(png)]),
    source,
    target,
    mode: "copy",
  });
  expect(summary.missing).toBe(1);
  expect(isMigrationComplete(summary)).toBe(false);
});

it("reports a digest mismatch as missing when the store verifies reads", async () => {
  const { sourceGateway, source, target } = pair();
  const live = liveOf(png);
  // The S3 adapter verifies on read, so wrong bytes and an absent object are
  // indistinguishable here. Both must fail closed; neither may report success.
  sourceGateway.objects.set(live.storageKey, {
    bytes: Uint8Array.from([9, 9, 9]),
    contentType: "image/png",
    updatedAt: new Date(),
  });
  const summary = await runMigration({
    keys: iterable([live]),
    source,
    target,
    mode: "copy",
  });
  expect(summary).toMatchObject({ missing: 1, corrupt: 0, copied: 0 });
  expect(isMigrationComplete(summary)).toBe(false);
});

it("reports corruption when an unverified source returns the wrong bytes", async () => {
  // The filesystem adapter does not verify on read, so this is the case where
  // the engine sees bytes that disagree with the key.
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-migrate-")));
  try {
    const live = liveOf(png);
    await mkdir(join(root, live.sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(root, live.storageKey), Buffer.from([9, 9, 9]));
    const { target } = pair();
    const summary = await runMigration({
      keys: iterable([live]),
      source: createFilesystemBlobStore({ root }),
      target,
      mode: "copy",
    });
    expect(summary).toMatchObject({ corrupt: 1, copied: 0 });
    expect(isMigrationComplete(summary)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a key whose recorded length disagrees with the database", async () => {
  const { source, target } = pair();
  await source.put(png);
  const live = { ...liveOf(png), bytes: png.length + 1 };
  // Present, readable and digest-correct, but the database says otherwise.
  expect(await migrateKey(live, source, target, "copy")).toBe("corrupt");
});

it("touches neither store for malformed live-key metadata", async () => {
  const touched: string[] = [];
  const guard = stubStore({
    async read() {
      touched.push("read");
      return null;
    },
    async put() {
      touched.push("put");
      throw new Error("unreachable");
    },
  });
  expect(
    await migrateKey({ ...liveOf(png), bytes: 0 }, guard, guard, "copy"),
  ).toBe("corrupt");
  expect(touched).toEqual([]);

  const valid = liveOf(png);
  expect(isValidLiveKey(valid)).toBe(true);
  expect(isValidLiveKey({ ...valid, bytes: 0 })).toBe(false);
  expect(isValidLiveKey({ ...valid, bytes: 1.5 })).toBe(false);
  expect(isValidLiveKey({ ...valid, sha256: "A".repeat(64) })).toBe(false);
  expect(isValidLiveKey({ ...valid, storageKey: `ff/${valid.sha256}` })).toBe(
    false,
  );
});

it("does not report success when the write cannot be read back", async () => {
  const live = liveOf(png);
  const source = stubStore({
    async read() {
      return new Uint8Array(png);
    },
  });
  const target = stubStore({
    async put() {
      return {
        storageKey: live.storageKey,
        sha256: live.sha256,
        mimeType: "image/png",
        bytes: live.bytes,
      };
    },
    async read() {
      return null;
    },
  });
  expect(await migrateKey(live, source, target, "copy")).toBe("failed");
});

it("counts a thrown write as a failure without aborting the run", async () => {
  const { source, target } = pair();
  await source.put(png);
  await source.put(jpeg);
  const failing = stubStore({
    async read(key) {
      return target.read(key);
    },
    async put() {
      throw new Error("bucket unavailable");
    },
    async probe() {},
  });
  const summary = await runMigration({
    keys: iterable([liveOf(png), liveOf(jpeg)]),
    source,
    target: failing,
    mode: "copy",
  });
  expect(summary.live).toBe(2);
  expect(summary.failed).toBe(2);
  expect(isMigrationComplete(summary)).toBe(false);
});

it("honours the fence: an excluded key is never copied", async () => {
  const { targetGateway, source, target } = pair();
  const live = liveOf(png);
  await source.put(png);
  let fenced = 0;
  const summary = await runMigration({
    keys: iterable([live]),
    source,
    target,
    mode: "copy",
    fence: async (_key, _work) => {
      fenced++;
      return "excluded" as KeyOutcome;
    },
  });
  expect(fenced).toBe(1);
  expect(summary).toMatchObject({ live: 1, copied: 0, excluded: 1 });
  expect(targetGateway.objects.has(live.storageKey)).toBe(false);
  // A run with only exclusions is complete: the keys stopped being live.
  expect(isMigrationComplete(summary)).toBe(true);
});

it("runs a bounded pool over many keys and accounts for every one", async () => {
  const { source, target } = pair();
  const blobs = Array.from({ length: 12 }, (_, index) =>
    Buffer.concat([png, Buffer.from([index])]),
  );
  for (const blob of blobs) await source.put(blob);
  // Wrap the target so in-flight writes are actually observable, and slow
  // enough for overlap to happen at all.
  let inFlight = 0;
  let peak = 0;
  const wrapped: PrivateBlobStore = {
    backend: target.backend,
    lifecycle: target.lifecycle,
    async put(bytes) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await target.put(bytes);
      } finally {
        inFlight--;
      }
    },
    read: (key) => target.read(key),
    erase: (key, sha256) => target.erase(key, sha256),
    capacity: () => target.capacity(),
    probe: () => target.probe(),
  };
  const summary = await runMigration({
    keys: iterable(blobs.map(liveOf)),
    source,
    target: wrapped,
    mode: "copy",
    concurrency: 4,
  });
  expect(summary.live).toBe(12);
  expect(summary.copied).toBe(12);
  expect(summary.bytesCopied).toBe(blobs.reduce((sum, b) => sum + b.length, 0));
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(4);
  expect(isMigrationComplete(summary)).toBe(true);
});

it("counts a key the fence reverted because it stopped being live", async () => {
  const { targetGateway, source, target } = pair();
  const live = liveOf(png);
  await source.put(png);
  const summary = await runMigration({
    keys: iterable([live]),
    source,
    target,
    mode: "copy",
    fence: async (_key, work) => {
      expect(await work()).toBe("copied");
      // The CLI erases its own fresh copy in this case.
      await target.erase(live.storageKey, live.sha256);
      return "reverted";
    },
  });
  expect(summary).toMatchObject({ live: 1, copied: 0, reverted: 1 });
  expect(targetGateway.objects.has(live.storageKey)).toBe(false);
  expect(isMigrationComplete(summary)).toBe(true);
});

it("does not let a throwing progress sink fail the migration", async () => {
  const { source, target } = pair();
  await source.put(png);
  const summary = await runMigration({
    keys: iterable([liveOf(png)]),
    source,
    target,
    mode: "copy",
    onProgress: () => {
      throw new Error("sink down");
    },
  });
  expect(summary.copied).toBe(1);
  expect(isMigrationComplete(summary)).toBe(true);
});

it("reports an iterator failure instead of a partial success", async () => {
  const { source, target } = pair();
  await source.put(png);
  const broken = async function* () {
    yield liveOf(png);
    throw new Error("database went away");
  };
  await expect(
    runMigration({ keys: broken(), source, target, mode: "copy" }),
  ).rejects.toThrow("database went away");
});

it("verify mode counts absent and unverifiable targets as missing", async () => {
  const { source, target } = pair();
  await source.put(png);
  await source.put(jpeg);
  await target.put(png);
  const summary = await runMigration({
    keys: iterable([liveOf(png), liveOf(jpeg)]),
    source,
    target,
    mode: "verify",
  });
  expect(summary).toMatchObject({
    live: 2,
    verified: 1,
    missing: 1,
    copied: 0,
  });
  expect(isMigrationComplete(summary)).toBe(false);
});
