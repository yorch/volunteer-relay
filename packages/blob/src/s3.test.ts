import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { BlobError } from "./contracts.ts";
import { createS3BlobStore } from "./s3.ts";
import { createFakeS3Gateway, keyFor } from "./testing/fake-gateway.ts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22]);

it("refuses a bucket owned by a different deployment before writing bytes", async () => {
  const gateway = createFakeS3Gateway({
    ".relay-deployment": new TextEncoder().encode("deployment-other"),
  });
  const store = createS3BlobStore({ gateway, deploymentId: "deployment-mine" });
  await expect(store.put(png)).rejects.toThrow(/different deployment/);
  expect([...gateway.objects.keys()]).toEqual([".relay-deployment"]);
});

it("claims an unowned bucket once and tolerates a concurrent claim", async () => {
  const gateway = createFakeS3Gateway();
  const first = createS3BlobStore({ gateway, deploymentId: "deployment-a" });
  await first.probe();
  expect(
    new TextDecoder().decode(
      gateway.objects.get(".relay-deployment")?.bytes ?? new Uint8Array(),
    ),
  ).toBe("deployment-a");
  // A second process for the same deployment re-reads the marker.
  const second = createS3BlobStore({ gateway, deploymentId: "deployment-a" });
  await expect(second.probe()).resolves.toBeUndefined();
});

it("verifies bytes before erasing and keeps a corrupt object", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({ gateway, deploymentId: "deployment-a" });
  const key = keyFor(png);
  gateway.objects.set(key, {
    bytes: Uint8Array.from([1, 2, 3]),
    contentType: "image/png",
    updatedAt: new Date(),
  });
  expect(await store.read(key)).toBeNull();
  await expect(store.erase(key, key.slice(3))).rejects.toBeInstanceOf(
    BlobError,
  );
  expect(gateway.objects.has(key)).toBe(true);
});

it("refuses to erase an object beyond the size bound", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({
    gateway,
    deploymentId: "deployment-a",
    maxBytes: 8,
  });
  const big = Buffer.alloc(64, 1);
  const key = keyFor(big);
  gateway.objects.set(key, {
    bytes: Uint8Array.from(big),
    contentType: "image/png",
    updatedAt: new Date(),
  });
  await expect(store.erase(key, key.slice(3))).rejects.toMatchObject({
    code: "corrupt",
  });
  expect(gateway.objects.has(key)).toBe(true);
});

it("removes every version when versioned erasure is enabled", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({
    gateway,
    deploymentId: "deployment-a",
    erasureMode: "versions",
  });
  const write = await store.put(png);
  // A delete marker leaves the previous version behind.
  await gateway.delete(write.storageKey);
  expect(gateway.versions.get(write.storageKey)?.length).toBe(1);
  await store.erase(write.storageKey, write.sha256);
  expect(gateway.objects.has(write.storageKey)).toBe(false);
  expect(gateway.versions.get(write.storageKey)?.length ?? 0).toBe(0);
});

it("maps provider quota failures and never reports a silent success", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({ gateway, deploymentId: "deployment-a" });
  await store.probe();
  gateway.failNext({ $metadata: { httpStatusCode: 507 } });
  await expect(store.put(png)).rejects.toMatchObject({ code: "quota" });
  expect(gateway.objects.has(keyFor(png))).toBe(false);
});

it("reconciles in bounded pages and leaves referenced objects alone", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({
    gateway,
    deploymentId: "deployment-a",
    reconcileMinimumAgeMs: 0,
  });
  const keep = await store.put(png);
  const drop = [
    await store.put(jpeg),
    await store.put(Buffer.from([0xff, 0xd8, 0xff, 0x33])),
  ];
  const settle = async (
    blob: { storageKey: string; sha256: string },
    done: () => Promise<void>,
  ) => {
    if (blob.storageKey !== keep.storageKey)
      await store.erase(blob.storageKey, blob.sha256);
    await done();
  };
  // Each call is one bounded page; a sweep covers the bucket over successive
  // scheduled runs, so three pages is enough for three objects here.
  const examined = await store.lifecycle.recover(settle, { limit: 2 });
  expect(examined).toBeGreaterThan(0);
  await store.lifecycle.recover(settle, { limit: 2 });
  await store.lifecycle.recover(settle, { limit: 2 });
  expect(await store.read(keep.storageKey)).not.toBeNull();
  for (const blob of drop) expect(await store.read(blob.storageKey)).toBeNull();
});

it("does not touch objects newer than the reconcile floor", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({
    gateway,
    deploymentId: "deployment-a",
    reconcileMinimumAgeMs: 3_600_000,
  });
  const write = await store.put(png);
  let called = 0;
  const examined = await store.lifecycle.recover(async (_blob, done) => {
    called++;
    await done();
  });
  expect(examined).toBe(0);
  expect(called).toBe(0);
  expect(await store.read(write.storageKey)).not.toBeNull();
});

it("keeps the digest in the key so replays never overwrite other content", async () => {
  const gateway = createFakeS3Gateway();
  const store = createS3BlobStore({ gateway, deploymentId: "deployment-a" });
  const first = await store.put(png);
  const second = await store.put(jpeg);
  expect(first.storageKey).not.toBe(second.storageKey);
  expect(await store.read(first.storageKey)).toEqual(new Uint8Array(png));
  expect(await store.read(second.storageKey)).toEqual(new Uint8Array(jpeg));
});

it("computes keys the same way for both digests", () => {
  expect(keyFor(png)).toBe(
    `${createHash("sha256").update(png).digest("hex").slice(0, 2)}/${createHash(
      "sha256",
    )
      .update(png)
      .digest("hex")}`,
  );
});
