import { describe, expect, it } from "vitest";
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

describe("production secrets and connection settings", () => {
  const production = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "s".repeat(40),
    DATABASE_URL: "postgres://app:synthetic@db.example.invalid:5432/relay",
  } as const;

  it("requires an explicit DATABASE_URL only in production", () => {
    const { DATABASE_URL: _omitted, ...withoutUrl } = production;
    expect(() => parseEnvironment(withoutUrl)).toThrow(/DATABASE_URL/);
    expect(parseEnvironment(production).DATABASE_URL).toBe(
      "postgres://app:synthetic@db.example.invalid:5432/relay",
    );
    expect(parseEnvironment({ NODE_ENV: "test" }).DATABASE_URL).toBe(
      "postgres://relay:relay@localhost:5432/relay",
    );
  });

  it("reports the missing DATABASE_URL alongside schema issues", () => {
    expect(() => parseEnvironment({ NODE_ENV: "production" })).toThrow(
      /auth secret[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*auth secret/,
    );
  });

  it("requires a long Telegram webhook secret in production", () => {
    const short = "w".repeat(31);
    expect(() =>
      parseEnvironment({ ...production, TELEGRAM_WEBHOOK_SECRET: short }),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(
      parseEnvironment({
        ...production,
        TELEGRAM_WEBHOOK_SECRET: "w".repeat(32),
      }).TELEGRAM_WEBHOOK_SECRET,
    ).toHaveLength(32);
    // Local replay/polling development keeps short synthetic secrets.
    expect(
      parseEnvironment({
        NODE_ENV: "development",
        TELEGRAM_WEBHOOK_SECRET: "a",
      }).TELEGRAM_WEBHOOK_SECRET,
    ).toBe("a");
    expect(() =>
      parseEnvironment({ TELEGRAM_WEBHOOK_SECRET: "x".repeat(257) }),
    ).toThrow();
  });

  it("validates the retention ledger key through the schema", () => {
    expect(parseEnvironment(production).RETENTION_LEDGER_KEY).toBeUndefined();
    expect(() =>
      parseEnvironment({ ...production, RETENTION_LEDGER_KEY: "too-short" }),
    ).toThrow(/RETENTION_LEDGER_KEY/);
    expect(
      parseEnvironment({
        ...production,
        RETENTION_LEDGER_KEY: "k".repeat(32),
      }).RETENTION_LEDGER_KEY,
    ).toBe("k".repeat(32));
  });
});

describe("operator allowlist configuration", () => {
  it("is absent by default", () => {
    expect(parseEnvironment({}).OPERATOR_ACCOUNTS).toBeUndefined();
  });

  it("accepts userId:email entries", () => {
    expect(
      parseEnvironment({
        OPERATOR_ACCOUNTS: "user-1:owner@example.org",
      }).OPERATOR_ACCOUNTS,
    ).toBe("user-1:owner@example.org");
  });

  it("refuses a malformed list at boot instead of granting nothing quietly", () => {
    for (const value of [
      "owner@example.org",
      "user-1:",
      ":owner@example.org",
      "user 1:owner@example.org",
      "user-1:not-an-email",
      "user-1:a@example.org,user-2:a@example.org",
      "user-1:a@example.org,user-1:b@example.org",
      "user-1:a@example.invalid",
      Array.from(
        { length: 21 },
        (_, index) => `user-${index}:person${index}@example.org`,
      ).join(","),
    ])
      expect(() => parseEnvironment({ OPERATOR_ACCOUNTS: value })).toThrow(
        /OPERATOR_ACCOUNTS/,
      );
  });

  it("cannot coexist with the public demo credentials", () => {
    expect(() =>
      parseEnvironment({
        DEMO_MODE: "true",
        OPERATOR_ACCOUNTS: "user-1:owner@example.org",
      }),
    ).toThrow(/OPERATOR_ACCOUNTS/);
    // Blank entries count as "not configured", not as an enabled console.
    expect(
      parseEnvironment({ DEMO_MODE: "true", OPERATOR_ACCOUNTS: "  " })
        .OPERATOR_ACCOUNTS,
    ).toBe("  ");
  });
});
