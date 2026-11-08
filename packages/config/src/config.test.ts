import { expect, it } from "vitest";
import { parseEnvironment } from "./index.ts";

it("rejects unsafe production defaults", () => {
  expect(() => parseEnvironment({ NODE_ENV: "production" })).toThrow();
  expect(() =>
    parseEnvironment({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "x".repeat(32),
      DEMO_MODE: "true",
    }),
  ).toThrow();
  expect(parseEnvironment({}).DEMO_MODE).toBe("false");
});

it("defaults to filesystem storage and refuses an incomplete S3 configuration", () => {
  expect(parseEnvironment({}).BLOB_STORE).toBe("filesystem");
  expect(() => parseEnvironment({ BLOB_STORE: "s3" })).toThrow(/S3_BUCKET/);
  expect(() =>
    parseEnvironment({ BLOB_STORE: "s3", S3_BUCKET: "relay" }),
  ).toThrow(/S3_DEPLOYMENT_ID/);
  expect(() =>
    parseEnvironment({
      BLOB_STORE: "s3",
      S3_BUCKET: "relay",
      S3_DEPLOYMENT_ID: "tidepath-prod",
      S3_ACCESS_KEY_ID: "key",
    }),
  ).toThrow(/access key and a secret/);
  const parsed = parseEnvironment({
    BLOB_STORE: "s3",
    S3_BUCKET: "relay",
    S3_DEPLOYMENT_ID: "tidepath-prod",
    S3_ENDPOINT: "https://objects.example.invalid",
  });
  expect(parsed.S3_ERASURE_MODE).toBe("unversioned");
  expect(parsed.S3_RECONCILE_MINIMUM_AGE_MS).toBe(3600000);
});

it("only allows a plaintext S3 endpoint in development with an explicit opt-in", () => {
  const base = {
    BLOB_STORE: "s3",
    S3_BUCKET: "relay",
    S3_DEPLOYMENT_ID: "local",
    S3_ENDPOINT: "http://127.0.0.1:7070",
  } as const;
  expect(() => parseEnvironment({ ...base })).toThrow(/https/);
  expect(
    parseEnvironment({
      ...base,
      NODE_ENV: "development",
      S3_ALLOW_INSECURE: "true",
    }).S3_ENDPOINT,
  ).toBe("http://127.0.0.1:7070");
  expect(() =>
    parseEnvironment({
      ...base,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "x".repeat(32),
      S3_ALLOW_INSECURE: "true",
    }),
  ).toThrow(/https/);
});

it("only allows a fallback root during an S3 cutover", () => {
  expect(() =>
    parseEnvironment({ BLOB_FALLBACK_ROOT: "/data/attachments" }),
  ).toThrow(/cutover window/);
  expect(() =>
    parseEnvironment({
      BLOB_STORE: "s3",
      S3_BUCKET: "relay",
      S3_DEPLOYMENT_ID: "prod",
      BLOB_FALLBACK_ROOT: "relative/path",
    }),
  ).toThrow(/absolute path/);
  const parsed = parseEnvironment({
    BLOB_STORE: "s3",
    S3_BUCKET: "relay",
    S3_DEPLOYMENT_ID: "prod",
    BLOB_FALLBACK_ROOT: "/data/attachments",
  });
  expect(parsed.BLOB_FALLBACK_ROOT).toBe("/data/attachments");
});
