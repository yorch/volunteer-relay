# Switching an existing deployment between filesystem and object storage (v2)

Status: implemented and verified, not yet reviewed. Incorporates an adversarial
review (codex, read-only, against the real source; contested claims re-verified
by hand). Branch `agents/A-S3-02`, base `origin/main`. Companion to
`s3-blob-storage-assessment.md`.

Verified end to end against a live deployment (Postgres 18.1 with migrations and
a seeded attachment, plus a real versitygw v1.10.0 bucket): dry-run reported the
live set, copy reported `copied: 1 / complete: true`, `--verify-only` reported
`verified: 1` and exited zero, a re-run reported `alreadyPresent: 1`, a
non-empty `.pending` spool was refused, and after redacting the source the work
list dropped to zero live keys and the erased bucket object was **not**
recreated. The transition store reported `backend: "transition"` and served the
old bytes through the fallback while reporting unknown capacity.

## 1. Problem

`BLOB_STORE` selects a backend per deployment, but there is no way to change it
for a deployment that already holds data. Flipping it today compounds three
failures:

| Failure                                  | Mechanism                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every existing attachment 503s           | Keys exist only in the old store; `read` returns `null`; the attachment reader maps that to `DEPENDENCY_UNAVAILABLE` (retryable, so it looks like a permanent transient). |
| Retention erasure silently stops erasing | `erase` treats an absent object as success, so a job for a filesystem-era blob finds nothing in the bucket, returns, and is recorded complete while the bytes remain.     |
| Write intents are stranded               | `.pending` recovery is filesystem-only.                                                                                                                                   |

Goal: a switch that is safe for real data, with no window in which erased bytes
become reachable again.

## 2. The work list comes from the database, never from a listing

Required bytes are the **live referenced** attachments, using the same predicate
the retention job uses (`packages/db/src/repositories/retention.ts`):

```sql
select distinct on (a.storage_key)
       a.storage_key, a.sha256, a.bytes
  from source_attachment_identity a
 where not exists (
         select 1 from source_redaction r
          where r.organization_id = a.organization_id
            and r.source_id = a.source_id)
   and a.storage_key > $cursor
 order by a.storage_key
 limit $page
```

Three properties, each deliberate:

- **Identity rows, not current revisions.** `source_attachment_identity` is
  keyed by organization + source + attachment and survives later revisions;
  attachment reads join `source_revision.revision = 1`
  (`packages/db/src/repositories/attachments.ts`). Narrowing to a "current"
  revision would drop bytes that are still readable.
- **`distinct on (storage_key)`.** Digests are shared across tenants and across
  duplicate uploads, so the raw join returns the same key many times. Duplicate
  rows must agree on digest and length; disagreement is a hard error, not a
  last-writer-wins choice.
- **A queued erasure job is not an exclusion criterion.** A digest can be
  redacted for one tenant and live for another. The reference check is global,
  and the erasure job itself re-checks references before deleting.

Copying anything outside the predicate is a resurrection bug: a redacted source
has its bytes scheduled for destruction, and copying them recreates them.

## 3. Fencing: every key is copied under the digest lock

The critical safety property. Writers are supposed to be stopped, but "supposed
to" is not a guarantee, and an operator-run tool must not depend on it. For each
key the CLI runs:

```
begin
  select pg_advisory_xact_lock(hashtextextended('blob:' || key, 0))
  re-check the live predicate for this key   -- the same predicate as above
  if no longer live: rollback, count excluded, skip
  copy + verify (inside the lock and the transaction)
commit
```

The lock is the same one every upload path, `pruneUnreferencedBlob` and
`runErasureJob` take. Consequences:

- A concurrent redaction that wins the lock first removes the reference, so the
  re-check sees it and the key is not copied.
- A redaction that arrives during the copy waits, then finds the bytes referenced
  by nobody and erases them from the target as well (both-store erase, §4).
- A not-fully-quiesced deployment cannot resurrect erased bytes through the
  migration.

Cost: a database transaction and an advisory lock are held across remote I/O.
Accepted for a maintenance tool, and bounded by per-key adapter timeouts. The
copy is not run concurrently with itself for the same key because the lock is
per key.

## 4. Transition store (`packages/blob/src/fallback.ts`)

A composed `PrivateBlobStore` for the bake window.

- `put` → primary only. The old store is frozen; a second writer would create
  bytes the reconciliation and erasure paths never see.
- `read` → primary, else fallback, and **the returned bytes are verified against
  the key digest** before being returned, whichever store answered. The
  filesystem adapter does not verify on read; the composed store does, so callers
  get one contract.
- `erase` → **both**, with both attempted even when the first throws, then a
  retryable error if either failed. This is required, not defensive:
  `runErasureJob` invokes the eraser exactly once, converts any throw into
  `failed`, and keeps the job open with a 60 s retry. Reporting success while one
  store still holds the bytes would record a completed erasure that never
  happened.
- `capacity` → primary.
- `probe` → both. A missing fallback volume means live attachments are
  unreachable, so readiness must fail rather than serve 503s per request.
- `lifecycle` → primary's intent log, scan and reconciliation.

Fallback-only orphans: the old store is frozen, so it produces no new writes.
References can still disappear (source deletion cascades), leaving objects on the
old volume that nothing scans. They are unreachable through the API (tombstone or
absent metadata) and the volume is deleted at retirement (§6 step 9), which is
why retirement is mandatory rather than optional.

Rejected: a read-only fallback. It reintroduces the silent-erasure failure.

## 5. Migration engine (`packages/blob/src/migrate.ts`)

Pure and testable, no database and no CLI knowledge:

```ts
runMigration({
  keys: AsyncIterable<LiveKey>,   // storageKey, sha256, bytes
  source: PrivateBlobStore,
  target: PrivateBlobStore,
  mode: "copy" | "verify",
  concurrency?: number,           // default 4
  fence?: (key, work) => Promise<KeyOutcome | "excluded">, // §3, CLI supplies it
  onProgress?: (progress) => void,
}): Promise<MigrationSummary>
```

Per key, `copy` mode:

1. Validate key/digest/length shape. Malformed database metadata is `corrupt`.
2. Read the **target**. If it is present, digest-correct **and** the length
   matches the database row, count `alreadyPresent` and skip. Length is checked,
   not just the digest, because a truncated object must not pass.
3. Otherwise read the source and verify digest and length. `null` from a source
   read means "absent or not byte-correct" — the store contract cannot tell those
   apart, so both fail closed.
4. `target.put(bytes)`, then read the target back and verify again. A put that is
   not readable and correct afterwards is `failed`, never `copied`.

`verify` mode reads the target only and counts `missing` (absent or
byte-incorrect).

`KeyOutcome`: `copied | alreadyPresent | verified | missing | corrupt | failed |
excluded`. Errors are isolated per key: one failure never aborts the run, but the
summary keeps the count so the exit gate fails.

Memory is bounded by `concurrency × maxBytes`; adapters buffer whole objects and
the size bound is enforced by the store. Concurrency is bounded by a fixed worker
pool, not by buffering the work list — the iterator is consumed at pool rate.

## 6. CLI (`scripts/blob-migrate.ts`) and runbook

```
node scripts/blob-migrate.ts --from <root|s3> --to <root|s3> [--verify-only]
       [--dry-run] [--page-size <n>] [--concurrency <n>] [--expect-live <n>]
node scripts/blob-migrate.ts --drain-pending --from <root>
```

- `s3` resolves to the configured bucket; a path resolves to a filesystem store.
  Identical or overlapping source and target is refused.
- **Both stores are probed before any work**, including `--verify-only`: reads
  alone do not prove write permission or bucket ownership (`probe` claims and
  verifies the deployment marker).
- The work list paginates to exhaustion internally; `--page-size` is a page size,
  not a cap, so a truncated run cannot report success. `--expect-live <n>` refuses
  to proceed if the database does not contain the expected number of live keys,
  which catches pointing the tool at the wrong database.
- `--drain-pending` exists because restarting the ordinary worker would also
  restart intake. It loops the filesystem recovery with `minimumAgeMs: 0` until
  the spool is empty, bounded, and reports remaining entries. Migration refuses to
  proceed while `.pending` is non-empty: an unsettled intent means the live set
  may not describe what is actually on disk. (The default recovery is unsuitable:
  it caps at 100 settlements per call, skips intents younger than an hour and
  ignores malformed records.)
- Exit zero only when `missing === 0 && corrupt === 0 && failed === 0` and every
  live key is accounted for as `copied`, `alreadyPresent` or `verified`.
- Counts only in output. No keys, no digests: a digest of a private image is a
  stable identifier even though it is not the bytes.

Runbook:

1. Deploy the tooling. Nothing changes while `BLOB_STORE` is unchanged.
2. Quiesce writers (web, worker). The lock in §3 is the backstop, not a licence
   to skip this.
3. `--drain-pending --from <root>` until empty.
4. `--from <root> --to s3 --dry-run` → check `live` and expected bytes;
   `--expect-live` against a known count.
5. `--from <root> --to s3` → copy and verify.
6. `--from <root> --to s3 --verify-only` → must exit zero. This is the
   "zero un-copied referenced keys" gate.
7. Flip `BLOB_STORE=s3` **and** `BLOB_FALLBACK_ROOT=<root>`, start web and worker.
8. Bake. New writes go to the bucket; old attachments read through the fallback;
   erasure hits both stores; the bucket's reconciliation cleans stale objects that
   are outside the live set and older than the age floor.
9. Re-run `--verify-only`, then remove `BLOB_FALLBACK_ROOT` **and delete the old
   volume in the same change**. Retaining it after that point silently weakens
   every later erasure.

Rollback is the reverse runbook and is only safe while the fallback is still
configured, because writes made after step 7 exist only in the bucket. It needs a
fresh live set and a fresh verification; a pre-flip list would both miss new
attachments and include since-redacted ones.

## 7. Non-goals (deliberate)

- **No continuous dual-write or CDC.** The copy is offline and idempotent.
- **No durable migration state machine** binding deployment identity, mount
  identity and configuration fingerprint. The per-key advisory lock plus the
  reference re-check is the safety property; the rest is bookkeeping that would
  not prevent a wrong copy. `--expect-live` and the pre-flight probe cover the
  realistic operator errors.
- **No dual-store reconciliation sweep.** The frozen store cannot gain new
  orphans, and retirement deletes it.
- **No `--prune`.** Deleting target objects outside the live set belongs to the
  worker's reconciliation, which takes the same lock and re-checks references;
  a migration-time prune would race it.
- **No migration metrics.** Counts and exit status only; the missing metrics in
  STATUS remain open.
- **No bucket-to-bucket server-side copy.** Reading and rewriting is the only way
  to verify both ends through the same contract.

## 8. Accepted limitations

- `read` cannot distinguish "absent" from "present but corrupt", so `missing`
  means "absent or not byte-correct". This fails closed; it cannot produce a
  false success.
- A target that already contains stale objects from an earlier abandoned attempt
  is not cleaned by the tool. Those objects are outside the live set, are
  unreachable through the API (tombstone or no metadata), and are removed by the
  bucket reconciliation after cutover once older than the age floor.
- An outage during `--verify-only` reports `missing > 0` and exits non-zero. That
  is the intended failure direction.
- Copying holds a transaction across remote I/O, as noted in §3.
- Backup/restore and the signed ledger are unchanged by this work: an S3
  deployment still needs the bucket snapshot procedure in `docs/operations.md`,
  and a restore still requires the current signed redaction ledger.

## 9. Failure modes covered by tests

Source present / target absent → `copied` and verified. Target present and
correct → `alreadyPresent`, no source read. Target present but truncated →
repaired or reported. Source missing a live key → `missing`, non-zero exit.
Source bytes disagree with the key → `corrupt`. Put succeeds but read-back fails
→ `failed`. `verify` mode counts absent and corrupt alike. Fence returns
`excluded` → no copy and no byte written. Erase: primary ok + fallback fails →
error; primary fails + fallback ok → error; both ok → success; both absent →
success. Fallback read is digest-verified in both directions. `.pending`
non-empty → CLI refuses. Duplicate key rows with conflicting metadata → hard
error. Interrupted run → re-run copies only what is absent.
