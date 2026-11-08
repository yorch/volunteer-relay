import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BlobError, type PrivateBlobStore } from "./contracts.ts";
import { createFallbackBlobStore } from "./fallback.ts";
import { createFilesystemBlobStore } from "./filesystem.ts";
import { createS3BlobStore } from "./s3.ts";
import { createFakeS3Gateway } from "./testing/fake-gateway.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 7, 7]);

function s3Store() {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({ gateway, deploymentId: "deployment-a" });
  return { gateway, store };
}

function keyOf(bytes: Uint8Array) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { storageKey: `${digest.slice(0, 2)}/${digest}`, sha256: digest };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fsStore() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-fallback-")));
  roots.push(root);
  return { root, store: createFilesystemBlobStore({ root }) };
}

it("writes only to the primary and reads through the fallback", async () => {
  const primary = s3Store();
  const fallback = s3Store();
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: fallback.store,
  });
  const write = await store.put(png);
  expect(primary.gateway.objects.has(write.storageKey)).toBe(true);
  expect(fallback.gateway.objects.has(write.storageKey)).toBe(false);

  // An attachment written before the cutover is only in the fallback.
  const legacy = Buffer.from([0xff, 0xd8, 0xff, 0x42]);
  const legacyKey = keyOf(legacy);
  await fallback.store.put(legacy);
  expect(await store.read(legacyKey.storageKey)).toEqual(
    new Uint8Array(legacy),
  );
  expect(store.backend).toBe("transition");
});

it("verifies fallback bytes against the key and refuses corrupt content", async () => {
  const primary = s3Store();
  const fallback = s3Store();
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: fallback.store,
  });
  const key = keyOf(png);
  // Filesystem reads do not verify; the composed store must.
  fallback.gateway.objects.set(key.storageKey, {
    bytes: Uint8Array.from([1, 2, 3]),
    contentType: "image/png",
    updatedAt: new Date(),
  });
  expect(await store.read(key.storageKey)).toBeNull();
});

it("erases from both stores", async () => {
  const primary = s3Store();
  const fallback = s3Store();
  const write = await primary.store.put(png);
  await fallback.store.put(png);
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: fallback.store,
  });
  await store.erase(write.storageKey, write.sha256);
  expect(primary.gateway.objects.has(write.storageKey)).toBe(false);
  expect(fallback.gateway.objects.has(write.storageKey)).toBe(false);
  // Both absent is still success, so a replay is safe.
  await expect(
    store.erase(write.storageKey, write.sha256),
  ).resolves.toBeUndefined();
});

it("fails the erasure when either store fails, after trying both", async () => {
  const primary = s3Store();
  const fallback = s3Store();
  const write = await primary.store.put(png);
  await fallback.store.put(png);
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: fallback.store,
  });

  // Primary fails, fallback still gets erased: a completed erasure must never be
  // reported while one store holds the bytes.
  primary.gateway.failNext({ $metadata: { httpStatusCode: 403 } });
  await expect(
    store.erase(write.storageKey, write.sha256),
  ).rejects.toBeInstanceOf(BlobError);
  expect(fallback.gateway.objects.has(write.storageKey)).toBe(false);

  // Fallback fails, primary already erased by the previous call, both retried.
  await primary.store.put(png);
  await fallback.store.put(png);
  fallback.gateway.failNext({ $metadata: { httpStatusCode: 500 } });
  await expect(
    store.erase(write.storageKey, write.sha256),
  ).rejects.toMatchObject({
    code: "unavailable",
    retryable: true,
  });
  expect(primary.gateway.objects.has(write.storageKey)).toBe(false);
});

it("rejects a mismatched erasure identity without touching either store", async () => {
  const primary = s3Store();
  const fallback = s3Store();
  const write = await primary.store.put(png);
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: fallback.store,
  });
  await expect(
    store.erase(write.storageKey, "b".repeat(64)),
  ).rejects.toMatchObject({ code: "invalid" });
  expect(primary.gateway.objects.has(write.storageKey)).toBe(true);
});

it("reports primary capacity and delegates lifecycle recovery to the primary", async () => {
  const primary = s3Store();
  const disk = await fsStore();
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: disk.store,
  });
  // Capacity belongs to the store that grows; S3 reports unknown.
  expect((await store.capacity()).availableBytes).toBeNull();

  // A stranded intent on the frozen volume is drained explicitly before the
  // cutover, never by the composed store's recovery loop.
  const write = await disk.store.put(png);
  await mkdir(join(disk.root, ".pending"), { recursive: true });
  await writeFile(
    join(disk.root, ".pending", `${write.sha256}.json`),
    JSON.stringify({ ...write, createdAt: 0 }),
  );
  let settled = 0;
  expect(
    await store.lifecycle.recover(
      async (_blob, done) => {
        settled++;
        await done();
      },
      { minimumAgeMs: 0 },
    ),
  ).toBe(0);
  expect(settled).toBe(0);
});

it("reports filesystem capacity when the primary is a disk volume", async () => {
  const disk = await fsStore();
  const primary = s3Store();
  const store = createFallbackBlobStore({
    primary: disk.store,
    fallback: primary.store,
  });
  expect(typeof (await store.capacity()).availableBytes).toBe("number");
});

it("fails readiness when the fallback store is unreachable", async () => {
  const primary = s3Store();
  const fallback = s3Store();
  const store = createFallbackBlobStore({
    primary: primary.store,
    fallback: fallback.store,
  });
  await expect(store.probe()).resolves.toBeUndefined();
  fallback.gateway.failNext({ $metadata: { httpStatusCode: 500 } });
  await expect(store.probe()).rejects.toBeInstanceOf(BlobError);
});

it("never lets a put reach the frozen store", async () => {
  const disk = await fsStore();
  const fallback = s3Store();
  const store = createFallbackBlobStore({
    primary: fallback.store,
    fallback: disk.store,
  });
  const write = await store.put(png);
  expect(await disk.store.read(write.storageKey)).toBeNull();
});

it("composes two filesystem stores without losing either copy", async () => {
  const first = await fsStore();
  const second = await fsStore();
  const store: PrivateBlobStore = createFallbackBlobStore({
    primary: first.store,
    fallback: second.store,
  });
  const write = await second.store.put(png);
  expect(await store.read(write.storageKey)).not.toBeNull();
  await store.erase(write.storageKey, write.sha256);
  expect(await first.store.read(write.storageKey)).toBeNull();
  expect(await second.store.read(write.storageKey)).toBeNull();
});
