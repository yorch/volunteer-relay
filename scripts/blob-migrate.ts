import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PrivateBlobStore } from "../packages/blob/src/index.ts";
import {
  createFilesystemBlobStore,
  createS3StoreFromEnvironment,
  isMigrationComplete,
  type LiveKey,
  runMigration,
} from "../packages/blob/src/index.ts";
import { parseEnvironment } from "../packages/config/src/index.ts";
import {
  createDatabase,
  pruneUnreferencedBlob,
  sql,
} from "../packages/db/src/index.ts";

/**
 * Offline, verified cutover of private attachment bytes between the filesystem
 * and an S3-compatible bucket.
 *
 * The work list is the database's live attachment set, never a directory or
 * bucket listing: copying a redacted key would recreate bytes the organization
 * asked to destroy. Each key is copied under the `blob:<key>` advisory lock with
 * a live-reference re-check, so a not-fully-quiesced deployment cannot
 * resurrect erased content through this tool.
 *
 *   node scripts/blob-migrate.ts --from /data/attachments --to s3 --dry-run
 *   node scripts/blob-migrate.ts --from /data/attachments --to s3
 *   node scripts/blob-migrate.ts --from /data/attachments --to s3 --verify-only
 *   node scripts/blob-migrate.ts --drain-pending --from /data/attachments
 */

const USAGE =
  "--from <root|s3> --to <root|s3> [--verify-only] [--dry-run] [--page-size n] [--concurrency n] [--expect-live n]\n       --drain-pending --from <root>";

type Spec = { kind: "filesystem"; root: string } | { kind: "s3"; label: "s3" };

function parseSpec(flag: string, value: string | undefined): Spec {
  if (!value) throw new Error(`${flag} requires <root|s3>`);
  if (value === "s3") return { kind: "s3", label: "s3" };
  if (value.includes("://")) throw new Error(`${flag} expects a path or "s3"`);
  return { kind: "filesystem", root: resolve(value) };
}

function overlaps(a: string, b: string): boolean {
  const nested = (outer: string, inner: string) =>
    inner === outer || inner.startsWith(`${outer}${sep}`);
  return nested(a, b) || nested(b, a);
}

function parseArgs(argv: readonly string[]) {
  const valued = new Set([
    "--from",
    "--to",
    "--page-size",
    "--concurrency",
    "--expect-live",
  ]);
  const flags = new Set([
    "--verify-only",
    "--dry-run",
    "--drain-pending",
    "--help",
  ]);
  const options: Record<string, string> = {};
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (flags.has(arg)) {
      switches.add(arg);
      continue;
    }
    if (!valued.has(arg))
      throw new Error(`Unsupported argument: ${arg}\n       ${USAGE}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${arg} requires a value`);
    options[arg] = value;
  }
  return {
    from: options["--from"],
    to: options["--to"],
    pageSize: Number.parseInt(options["--page-size"] ?? "500", 10),
    concurrency: Number.parseInt(options["--concurrency"] ?? "4", 10),
    expectLive:
      options["--expect-live"] === undefined
        ? undefined
        : Number.parseInt(options["--expect-live"] as string, 10),
    verifyOnly: switches.has("--verify-only"),
    dryRun: switches.has("--dry-run"),
    drainPending: switches.has("--drain-pending"),
    help: switches.has("--help"),
  };
}

const livePredicate = sql`
  not exists (
    select 1 from source_redaction r
     where r.organization_id = a.organization_id
       and r.source_id = a.source_id)
`;

async function assertConsistentLiveSet(
  db: ReturnType<typeof createDatabase>["db"],
) {
  // Duplicate digests are expected (shared images, multiple tenants); conflicting
  // metadata for one key is not, and must stop the run rather than pick one.
  const rows = await db.execute(sql`
    select a.storage_key
      from source_attachment_identity a
     where ${livePredicate}
     group by a.storage_key
    having count(distinct a.sha256) > 1 or count(distinct a.bytes) > 1
     limit 5`);
  if (rows.rows.length > 0)
    throw new Error(
      "Live attachment rows disagree on digest or length for the same storage key; resolve before migrating",
    );
}

async function liveTotals(
  db: ReturnType<typeof createDatabase>["db"],
): Promise<{ live: number; bytes: number }> {
  const rows = await db.execute(sql`
    select count(*)::bigint as live, coalesce(sum(t.bytes), 0)::bigint as bytes
      from (
        select distinct on (a.storage_key) a.storage_key, a.bytes
          from source_attachment_identity a
         where ${livePredicate}
         order by a.storage_key) t`);
  const row = rows.rows[0] ?? {};
  return { live: Number(row.live ?? 0), bytes: Number(row.bytes ?? 0) };
}

async function* liveKeys(
  db: ReturnType<typeof createDatabase>["db"],
  pageSize: number,
): AsyncGenerator<LiveKey> {
  let cursor = "";
  for (;;) {
    const rows = await db.execute(sql`
      select distinct on (a.storage_key) a.storage_key, a.sha256, a.bytes
        from source_attachment_identity a
       where ${livePredicate} and a.storage_key > ${cursor}
       order by a.storage_key
       limit ${pageSize}`);
    if (rows.rows.length === 0) return;
    for (const row of rows.rows)
      yield {
        storageKey: String(row.storage_key),
        sha256: String(row.sha256),
        bytes: Number(row.bytes),
      };
    cursor = String(rows.rows[rows.rows.length - 1]?.storage_key ?? "");
    if (rows.rows.length < pageSize) return;
  }
}

async function pendingCount(root: string): Promise<number> {
  const entries = await readdir(join(root, ".pending")).catch(
    () => [] as string[],
  );
  return entries.filter((entry) => entry.endsWith(".json")).length;
}

async function drainPending(
  db: ReturnType<typeof createDatabase>["db"],
  store: PrivateBlobStore,
  root: string,
): Promise<number> {
  const settle = (
    blob: { storageKey: string; sha256: string },
    done: () => Promise<void>,
  ) =>
    pruneUnreferencedBlob(db, blob, (key, sha) => store.erase(key, sha), done);
  let remaining = await pendingCount(root);
  for (let pass = 0; pass < 1000 && remaining > 0; pass++) {
    await store.lifecycle.recover(settle, { minimumAgeMs: 0, limit: 100 });
    const next = await pendingCount(root);
    if (next === remaining)
      throw new Error(
        `${next} write intent(s) could not be settled; inspect them before migrating`,
      );
    remaining = next;
  }
  if (remaining > 0)
    throw new Error(
      `${remaining} write intent(s) remain after draining; do not migrate yet`,
    );
  return remaining;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.info(USAGE);
    return;
  }
  const env = parseEnvironment(process.env);
  if (
    !Number.isSafeInteger(args.pageSize) ||
    args.pageSize < 1 ||
    args.pageSize > 5000
  )
    throw new Error("--page-size must be an integer between 1 and 5000");
  if (
    !Number.isSafeInteger(args.concurrency) ||
    args.concurrency < 1 ||
    args.concurrency > 16
  )
    throw new Error("--concurrency must be an integer between 1 and 16");

  const opened = createDatabase(env.DATABASE_URL);
  try {
    const db = opened.db;

    if (args.drainPending) {
      const source = parseSpec("--from", args.from);
      if (source.kind !== "filesystem")
        throw new Error("--drain-pending requires a filesystem --from");
      const store = createFilesystemBlobStore({
        root: source.root,
        maxBytes: env.ATTACHMENT_MAX_BYTES,
      });
      const remaining = await drainPending(db, store, source.root);
      console.info(
        JSON.stringify({
          event: "blob-drain-pending",
          remaining,
          settled: true,
        }),
      );
      return;
    }

    const from = parseSpec("--from", args.from);
    const to = parseSpec("--to", args.to);
    if (from.kind === "s3" && to.kind === "s3")
      throw new Error("--from and --to both resolve to the configured bucket");
    if (
      from.kind === "filesystem" &&
      to.kind === "filesystem" &&
      overlaps(from.root, to.root)
    )
      throw new Error("--from and --to must not overlap");

    const source: PrivateBlobStore =
      from.kind === "s3"
        ? createS3StoreFromEnvironment(env)
        : createFilesystemBlobStore({
            root: from.root,
            maxBytes: env.ATTACHMENT_MAX_BYTES,
          });
    const target: PrivateBlobStore =
      to.kind === "s3"
        ? createS3StoreFromEnvironment(env)
        : createFilesystemBlobStore({
            root: to.root,
            maxBytes: env.ATTACHMENT_MAX_BYTES,
          });

    // Reads alone do not prove write permission or bucket ownership.
    await source.probe();
    await target.probe();
    await assertConsistentLiveSet(db);

    if (from.kind === "filesystem") {
      const remaining = await pendingCount(from.root);
      if (remaining > 0)
        throw new Error(
          `${remaining} unsettled write intent(s) in the source; run --drain-pending first`,
        );
    }

    const totals = await liveTotals(db);
    if (args.expectLive !== undefined && args.expectLive !== totals.live)
      throw new Error(
        `Expected ${args.expectLive} live attachment(s) but the database reports ${totals.live}; refusing to migrate the wrong deployment`,
      );
    if (args.dryRun) {
      console.info(
        JSON.stringify({
          event: "blob-migrate",
          mode: "dry-run",
          from: from.kind === "s3" ? "s3" : "filesystem",
          to: to.kind === "s3" ? "s3" : "filesystem",
          live: totals.live,
          bytes: totals.bytes,
        }),
      );
      return;
    }

    const mode = args.verifyOnly ? "verify" : "copy";
    const summary = await runMigration({
      keys: liveKeys(db, args.pageSize),
      source,
      target,
      mode,
      concurrency: args.concurrency,
      // Fence each key the same way uploads and retention do.
      fence: async (key, work) =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('blob:' || ${key.storageKey},0))`,
          );
          const isLive = async () =>
            (
              await tx.execute(sql`
                select 1 from source_attachment_identity a
                 where a.storage_key = ${key.storageKey} and ${livePredicate}
                 limit 1`)
            ).rows.length > 0;
          if (!(await isLive())) return "excluded";
          const outcome = await work();
          if (outcome !== "copied") return outcome;
          // The lock serialises against redaction, but a redaction that
          // committed while we copied is only visible on a fresh read. The
          // erasure it queued will run against the still-active filesystem
          // store, so the target copy we just wrote would outlive the
          // completed erasure. Revert it while the lock is still held.
          if (await isLive()) return outcome;
          await target.erase(key.storageKey, key.sha256);
          return "reverted";
        }),
      onProgress: ({ processed }) => {
        if (processed % 500 === 0)
          console.info(
            JSON.stringify({ event: "blob-migrate-progress", processed }),
          );
      },
    });

    // A copy pass proves the keys it saw. It cannot prove the *set* it saw is
    // still the live set, so re-read the live set and verify the target against
    // that fresh snapshot before claiming success. Counts alone do not
    // establish coverage: a key inserted behind the cursor would be invisible.
    const verification =
      mode === "copy"
        ? await runMigration({
            keys: liveKeys(db, args.pageSize),
            source,
            target,
            mode: "verify",
            concurrency: args.concurrency,
          })
        : undefined;
    const complete =
      isMigrationComplete(summary) &&
      (verification === undefined || isMigrationComplete(verification));
    console.info(
      JSON.stringify({
        event: "blob-migrate",
        mode,
        from: from.kind === "s3" ? "s3" : "filesystem",
        to: to.kind === "s3" ? "s3" : "filesystem",
        expectedLive: totals.live,
        summary,
        ...(verification ? { verification } : {}),
        complete,
      }),
    );
    if (!complete)
      throw new Error(
        "Migration incomplete: some live attachments are missing, corrupt or failed; do not remove the fallback or switch storage",
      );
  } finally {
    await opened.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `Blob migration failed: ${error instanceof Error ? error.message : "unknown error"}`,
  );
  process.exitCode = 1;
}
