import { createHash } from "node:crypto";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createBlobStore } from "../packages/blob/src/index.ts";
import { parseEnvironment } from "../packages/config/src/index.ts";

/**
 * Opt-in operational check for an S3-compatible bucket.
 *
 * Never part of `verify`: it needs a live endpoint and credentials. Actions are
 * idempotent so it is safe to re-run against a deployed bucket.
 *
 *   node scripts/s3-bootstrap.ts          # ensure bucket + deployment marker
 *   node scripts/s3-bootstrap.ts --check  # probe only, change nothing
 *   node scripts/s3-bootstrap.ts --smoke  # also put/read/list/erase synthetic bytes
 */

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const smoke = args.includes("--smoke");
const unknown = args.filter((arg) => !["--check", "--smoke"].includes(arg));
if (unknown.length > 0) throw new Error("Unsupported argument");

const env = parseEnvironment(process.env);
if (env.BLOB_STORE !== "s3")
  throw new Error("s3-bootstrap requires BLOB_STORE=s3");
if (!env.S3_BUCKET || !env.S3_DEPLOYMENT_ID)
  throw new Error("s3-bootstrap requires S3_BUCKET and S3_DEPLOYMENT_ID");

const client = new S3Client({
  region: env.S3_REGION,
  ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
  ...(env.S3_FORCE_PATH_STYLE === undefined
    ? {}
    : { forcePathStyle: env.S3_FORCE_PATH_STYLE === "true" }),
  ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? {
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
      }
    : {}),
  maxAttempts: 3,
});

async function ensureBucket() {
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
    return "existing";
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status !== 404) throw error;
    if (checkOnly) throw new Error("Bucket is missing; run without --check");
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
    return "created";
  }
}

const bucket = await ensureBucket();
const store = createBlobStore(env);
await store.probe();

let smokeResult: Record<string, unknown> | undefined;
if (smoke) {
  const write = await store.put(png);
  const read = await store.read(write.storageKey);
  const digest = read ? createHash("sha256").update(read).digest("hex") : null;
  const page = await store.lifecycle.scan(null, 10);
  const listed = page.entries.some(
    (entry) => entry.storageKey === write.storageKey,
  );
  await store.erase(write.storageKey, write.sha256);
  const erased = (await store.read(write.storageKey)) === null;
  const capacity = await store.capacity();
  smokeResult = {
    digestMatches: digest === write.sha256,
    listed,
    erased,
    capacityIsUnknown: capacity.availableBytes === null,
  };
  if (!smokeResult.digestMatches || !listed || !erased)
    throw new Error("S3 smoke check failed");
}

console.info(
  JSON.stringify({
    event: "s3-bootstrap",
    bucket,
    backend: store.backend,
    erasureMode: env.S3_ERASURE_MODE,
    ...(smokeResult ? { smoke: smokeResult } : {}),
  }),
);
