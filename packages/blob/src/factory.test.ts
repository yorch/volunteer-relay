import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnvironment } from "@relay/config";
import { expect, it } from "vitest";
import {
  createBlobStore,
  createFilesystemStoreFromEnvironment,
  createS3StoreFromEnvironment,
} from "./factory.ts";

const secret = "x".repeat(40);

it("builds a filesystem store by default", () => {
  const env = parseEnvironment({});
  expect(createBlobStore(env).backend).toBe("filesystem");
  expect(createFilesystemStoreFromEnvironment(env).backend).toBe("filesystem");
});

it("composes the transition store only when a mounted fallback is configured", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-factory-")));
  try {
    const base = {
      BLOB_STORE: "s3",
      S3_BUCKET: "relay",
      S3_DEPLOYMENT_ID: "deployment-a",
      ATTACHMENT_MAX_BYTES: "1024",
    } as const;
    expect(createBlobStore(parseEnvironment({ ...base })).backend).toBe("s3");
    expect(
      createBlobStore(parseEnvironment({ ...base, BLOB_FALLBACK_ROOT: root }))
        .backend,
    ).toBe("transition");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a fallback root that is not mounted instead of creating it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-factory-")));
  const absent = join(root, "not-mounted");
  try {
    expect(() =>
      createBlobStore(
        parseEnvironment({
          BLOB_STORE: "s3",
          S3_BUCKET: "relay",
          S3_DEPLOYMENT_ID: "deployment-a",
          BLOB_FALLBACK_ROOT: absent,
        }),
      ),
    ).toThrow(/does not exist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("validates S3 settings even while the deployment runs on filesystem", () => {
  // Migration tooling builds an S3 store while `BLOB_STORE=filesystem`, and the
  // config schema deliberately skips the S3 checks in that mode.
  const insecure = parseEnvironment({
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: secret,
    DATABASE_URL: "postgres://app:synthetic@db.example.invalid:5432/relay",
    BLOB_STORE: "filesystem",
    S3_BUCKET: "relay",
    S3_DEPLOYMENT_ID: "deployment-a",
    S3_ENDPOINT: "http://objects.example.org",
    S3_ALLOW_INSECURE: "true",
  });
  expect(() => createS3StoreFromEnvironment(insecure)).toThrow(/https/);

  const incomplete = parseEnvironment({
    BLOB_STORE: "filesystem",
    S3_BUCKET: "relay",
    S3_DEPLOYMENT_ID: "deployment-a",
    S3_ACCESS_KEY_ID: "key-only",
  });
  expect(() => createS3StoreFromEnvironment(incomplete)).toThrow(
    /both an access key/,
  );

  const missing = parseEnvironment({ BLOB_STORE: "filesystem" });
  expect(() => createS3StoreFromEnvironment(missing)).toThrow(/not configured/);
});
