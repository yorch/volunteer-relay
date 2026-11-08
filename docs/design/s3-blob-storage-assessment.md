# S3-compatible private blob storage — assessment (v2)

Status: proposal, not accepted. Branch `agents/A-S3-01` (worktree
`/Users/yorch/code/volunteer-relay-S3`), base `629cb64`.

v2 incorporates an adversarial review pass (codex, read-only, against the real
source); contested claims were re-verified by hand. §9 lists what changed and
why. Where v2 and v1 disagree, v2 wins.

## 0. Decisions taken (v3)

| Question           | Decision                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Certified provider | **versitygw** (Apache-2.0, stateless, POSIX backend) as the reference target; adapter written to the lowest-common-denominator API so AWS S3, R2, SeaweedFS and RustFS also work. MinIO CE is archived upstream (last source-only release 2025-10, UI gutted) and is not a target. |
| Orphan cleanup     | **Bucket reconciliation only.** No intent table, no migration, no second connection. The per-digest advisory lock plus a global reference check remain the authority; object age is hygiene.                                                                                       |
| Cutover            | **No migration.** New installs choose a backend at install time; existing filesystem installs stay on filesystem. No dual-read, so no resurrection window.                                                                                                                         |
| Scope              | Steps 1–5 implemented: ports, rewiring, S3 adapter, reconciliation + version-aware erasure, readiness/docs/compose.                                                                                                                                                                |

Status: implemented on `agents/A-S3-01`, **not** reviewed or accepted. The
filesystem backend keeps byte-for-byte behaviour (verified by the existing
suites). The live check against a real versitygw `v1.10.0` container produced
`bucket: created`, digest match, list hit, erase converge and
`capacityIsUnknown: true`. That is provider evidence, not an acceptance claim,
and the shared Postgres-backed integration suites have not been re-run for this
branch (they need a private database).

Related: IMPLEMENTATION-PLAN.md ("retain an interface for future object
storage", single-host local-disk limitation), ADR 0005 (attachment identity),
docs/CONTRACTS.md (private attachment reads), docs/operations.md (backup /
restore / signed redaction ledger).

## 1. Scope

Application runtime state on the filesystem is one thing: private attachment
bytes plus their write-intent spool. The rest of the repository's `node:fs` use
is build/tooling and stays local, but three of those items are operationally
load-bearing and must appear in the change's blast radius even though they are
not migrated:

| FS user                                                                             | Runtime state?                                        | S3-backed?                                       |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| `packages/intake/src/{index,private-reader,blob-writes,telegram-photo}.ts`          | bytes + intents                                       | **yes**                                          |
| `apps/web/lib/product/extensions.ts`, `apps/web/lib/auth/product-demo.ts`           | via intake                                            | wiring only                                      |
| `apps/web/lib/telegram/production.ts`                                               | via intake (webhook path)                             | wiring only                                      |
| `apps/web/lib/product/operations.ts`, `apps/web/app/api/ready/route.ts`             | capacity probe                                        | semantics change                                 |
| `apps/worker/src/{index,telegram}.ts`                                               | read / erase                                          | wiring only                                      |
| `scripts/retention.ts`                                                              | **signed redaction ledger required for safe restore** | no — but backup/restore contract must be revised |
| `packages/db/src/migrations.ts`                                                     | no (bundled code)                                     | no                                               |
| `scripts/**` coordination board, evidence, dashboard, watchdog leases, usage ledger | no (local operator tooling)                           | no                                               |
| `/tmp`, Next.js `.next/cache`, Postgres volume, Caddy state                         | no                                                    | no                                               |

So: attachment blobs + intent spool + capacity signal. "Move everything to S3"
is not a meaningful goal — the operator tooling is deliberately host-local, and
removing the attachments volume does not make the deployment stateless.

## 2. Call sites and required semantics

The adapter seam that the plan promised does not exist yet: five call sites
construct `createPrivateFilesystemBlobStore(root, {maxBytes})` directly and
import the free `readPrivateBlob` / `erasePrivateBlob`.

Writes (`put` → `BlobWrite`), all wrapped in `withTrackedBlobWrites`:

1. `packages/intake/src/index.ts:724` — the adapter (mime sniff, size bound,
   `statfs` precheck, digest key, temp + `rename`, `fsync`).
2. `packages/intake/src/telegram-photo.ts:77` — Telegram photo intake.
3. `apps/web/lib/product/extensions.ts:264` — `POST source-photo`.
4. `apps/web/lib/product/extensions.ts:439` — import commit (batch).
5. `apps/web/lib/auth/product-demo.ts:61` — explicit demo seed.
6. `apps/web/lib/telegram/production.ts:76` (via `telegram-photo.ts`) —
   the production webhook path. **Omitted in v1.** Leaving it unwired splits
   storage between webhook and polling transports.

Reads (`readPrivateBlob(root, key)` → `Uint8Array | null`):
7. `apps/web/lib/product/extensions.ts:165` → `AttachmentReader`
(`packages/domain/core/src/attachments/attachment-reader.ts`), which
**already re-hashes the bytes and compares length + SHA-256** against the
database row before returning them. Any S3 read path inherits that check —
so "verify on read" is existing behaviour to preserve, not an improvement to
add.
8. `apps/web/lib/product/production.ts:56` — the `AttachmentReader` blob port.
9. `apps/worker/src/index.ts:198` — extraction image input.
10. `apps/web/lib/auth/product-demo.ts:44` — demo self-check.

Erases (`erasePrivateBlob(root, key, sha256)`, digest-verified, idempotent):
`apps/worker/src/index.ts:99,107` (recovery + retention jobs),
`apps/worker/src/telegram.ts:138`, `apps/web/lib/telegram/production.ts:110`,
`extensions.ts:314,461`, `product-demo.ts:76`.

Staging / settlement:

- `withTrackedBlobWrites` stages an intent under `<root>/.pending` **before**
  the write, and runs `settle` in a `finally` — **on success as well as
  failure** (v1 implied failure only). `settle` is `pruneUnreferencedBlob`.
- `recoverPendingBlobWrites` sweeps `.pending`, ≥1 h age, ≤100 entries.

Capacity / readiness:

- `put()` refuses below `2 * maxBytes` free; `GET /api/ready` applies the same
  floor; `GET operations` reports nullable `availableStorageBytes`.

Non-negotiables to preserve exactly: digest-key layout `<2 hex>/<64 hex>`;
PNG/JPEG/WebP magic validation; cross-tenant dedupe (one object per digest,
reference-counted); no caller-controlled key; no public or presigned URL;
unknown is `null`.

## 3. The correctness mechanism is a lock, not an age

This is the single most important finding of the review, and it changes the
design.

Every write path takes `pg_advisory_xact_lock(hashtextextended('blob:<key>',0))`
inside the same transaction that persists the source revision, and writes bytes
while holding it (`extensions.ts:251–269`, `telegram/production.ts:78–90`).
`pruneUnreferencedBlob` (`packages/db/src/repositories/blob-pruning.ts`) takes
**the same lock** before its global reference check and erase. So:

- A slow transaction blocks GC. It cannot lose its blob to a concurrent sweep.
- An age threshold is therefore **not** a safety property. v1 proposed one as
  if it were; that was wrong.
- The orphan problem is narrower than v1 claimed: the in-process `finally`
  already reconciles every touched key. The filesystem `.pending` spool exists
  only for the window where the **process dies** mid-transaction.

Consequences for S3:

- Reconciliation GC is still the right crash-window mechanism, but it must
  take the same advisory lock per candidate key and do the same global
  reference check. Age is then only cheap hygiene (avoid churning fresh
  objects), configured conservatively, never relied on for safety.
- A bare "list and delete anything unreferenced" sweeper **without** the lock is
  a delete-my-evidence bug, not a design choice.
- Two deployments sharing one bucket prefix would let either collector delete
  the other's evidence. The bucket/prefix must be exclusively owned and its
  ownership asserted at startup (deployment id recorded in the bucket, refuse
  on mismatch).
- Both upload paths call the store _inside_ the accepting transaction while
  holding the digest lock. That is what makes compensation correct, but it also
  means remote storage latency now sits inside a database transaction and
  extends lock hold time. This is accepted, not hidden: keep the endpoint local,
  and treat lock waits as a capacity signal rather than raising timeouts.

## 4. Proposed seam

Two contracts, not one — v1's single port could not express lifecycle
enumeration, so implementers would have bypassed it.

```ts
export interface PrivateBlobStore {
  // hot path, per-request
  put(bytes: Uint8Array): Promise<BlobWrite>; // idempotent per digest
  read(key: string): Promise<Uint8Array | null>; // null when absent/unreadable
  erase(key: string, sha256: string): Promise<void>; // idempotent
  capacity(): Promise<{ availableBytes: number | null }>; // null = unknown
}

export interface BlobLifecycle {
  // worker-only, out of the hot path
  // Bounded, resumable enumeration. Never used by request handlers.
  scan(
    cursor: string | null,
    limit: number,
  ): Promise<{
    objects: Array<{ key: string; updatedAt: Date }>;
    cursor: string | null;
  }>;
  // Durable intent for backends that cannot list (filesystem keeps .pending).
  intents(): BlobIntentLog;
}
```

Rules the interface must state, because they are where the bugs live:

- every method has a deadline and a bounded payload; no unbounded buffers;
- typed error taxonomy (`absent | denied | quota | unavailable | corrupt`)
  mapped to `Result` codes at the edge, never leaking provider strings;
- `put`/`erase` retry-safe; ambiguous timeouts are retried, never claimed
  exactly-once;
- `read` result is verified by the caller's existing digest check;
- the store is constructed once per process from config and injected;
  `root` disappears from business signatures;
- startup fails closed if the selected backend is under-configured. A silent
  fallback to local disk would scatter bytes across hosts.

## 5. Backend-specific decisions

### 5.1 Create-once is not needed; overwrite cost is

Content-addressed keys mean different bytes can never collide, so `PutObject`
overwriting is acceptable and we do **not** need `If-None-Match: *` (which AWS,
MinIO and R2 support but B2 does not). But overwrite is not free: on a
versioned bucket it creates a noncurrent version, resets `LastModified`, and
inflates cost. Define replay semantics explicitly — put-identical-bytes is
allowed to be a no-op or a cheap overwrite, but the bucket's versioning policy
must make that safe rather than accumulating version garbage.

### 5.2 Erasure must be version-aware and fail closed

Today: read bytes, verify SHA-256, unlink, then sweep stray `.tmp` files, under
the shared lock. S3 equivalent must answer three questions v1 left open:

- **Versions.** On a versioned bucket, `DeleteObject` leaves a delete marker and
  the bytes remain. Default: refuse a versioned bucket; opt in with
  `S3_ERASURE_MODE=versions`, which enumerates and deletes every version
  (`s3:ListBucketVersions`, `s3:DeleteObjectVersion`). Silently leaving bytes
  behind after a retention/GDPR erasure is a correctness failure, not a
  configuration detail.
- **Verification.** Checksum metadata is not proof: user metadata can repeat a
  claimed hash, AWS needs checksum mode on HEAD, and multipart SHA-256 may be
  composite. So verification stays **GET + local SHA-256** for objects within
  the size bound (the current cap makes this affordable), with HEAD used only
  as a cheap precheck. Do not downgrade the guarantee to a metadata compare.
- **Outcome.** "Deletion must always succeed" (v1) conflates intent with
  result. A denied, locked (Object Lock / legal hold) or 5xx delete is a
  **retryable erasure failure** that keeps the job open and visible — never a
  completed erasure record. Missing object is success.

### 5.3 Capacity and readiness

- `capacity()` returns `null` for S3; `availableStorageBytes` is already
  nullable and the UI already renders the unknown case. Do not fabricate zero.
- `put()` drops the free-space precheck and maps provider quota errors (403
  quota / 507) to `DEPENDENCY_UNAVAILABLE`, never `VALIDATION`.
- Readiness is harder than v1 claimed. `HeadBucket` requires **`s3:ListBucket`**
  in AWS IAM, so a least-privilege object-only credential cannot probe
  readiness; and a successful `HeadBucket` does not prove `PutObject`, SSE/KMS
  or `DeleteObject` work. Options: grant `ListBucket` to the web role
  (recommended — the reconciliation check needs it anyway, on the worker), or
  probe an actual object round-trip at startup and cache the result with
  hysteresis. Readiness must not flap: bounded deadline, short cache, and a
  single structured log line on transition.

### 5.4 IAM, TLS, encryption

- Credentials via the standard chain (`AWS_*`, shared config, instance/task
  role). Never in URLs, never logged.
- `S3_ENDPOINT` must be `https` in production; `http` only with
  `S3_ALLOW_INSECURE=true` and `NODE_ENV !== production` (local MinIO).
- Least privilege: web = `GetObject`, `PutObject`, `DeleteObject` on the
  prefix; worker adds `ListBucket` (+ version verbs in versions mode). Bucket
  actions cannot be prefix-scoped, so `ListBucket` is asserted with a
  `s3:prefix` condition where the provider honours it.
- Encryption is **not** one portable toggle: SSE-S3 vs SSE-KMS differ, R2
  rejects AWS SSE-KMS headers, and KMS adds key-policy permissions. Treat it as
  a per-provider capability, validate at startup, default to provider-managed
  encryption.

### 5.5 Portability matrix (corrected)

| Capability              | AWS S3   | MinIO                                 | R2                  | B2                  | Design stance              |
| ----------------------- | -------- | ------------------------------------- | ------------------- | ------------------- | -------------------------- |
| Path-style addressing   | yes      | optional (configurable, not required) | no (virtual-host)   | yes                 | config flag, default auto  |
| `If-None-Match: *`      | yes      | yes                                   | yes (extension)     | no                  | not used                   |
| Object SHA-256 checksum | yes      | yes                                   | per-type, versioned | partial             | precheck only              |
| `ListObjectsV2`         | yes      | yes                                   | yes                 | yes                 | ≤1000 keys/page, resumable |
| Strong read-after-write | yes      | yes                                   | yes                 | same-second caveats | do not assume for B2       |
| Versioning              | optional | optional                              | n/a                 | yes                 | erasure hazard             |
| SSE-KMS headers         | yes      | yes (KES)                             | **rejected**        | partial             | capability-probed          |

Only this API surface is used: `PutObject`, `GetObject`, `HeadObject`,
`DeleteObject`, `HeadBucket`, `ListObjectsV2` (+ version verbs in versions
mode). Everything else is optional and probed once at startup.

### 5.6 Dependency

`@aws-sdk/client-s3` v3, pinned, imported only inside the adapter package, with
a server-only module boundary so it never reaches a client bundle. Hand-rolling
SigV4 + retry + pagination is a worse security and correctness trade than ~10 MB
of pinned transitive code.

### 5.7 Testing

One adapter **contract suite** run against: in-memory fake (default, no
network), filesystem (temp dir), and opt-in real MinIO (`S3_TEST_ENDPOINT`).
The fake must simulate: PUT succeeds + DB rollback (orphan), PUT success
reported as timeout, delete of missing key, denied/locked delete, checksum
absent, malformed/partial list, oversized body, quota error.

Mandatory cases the review added: two tenants sharing one digest; upload vs GC
vs erasure lock races; crash after remote PUT before receipt; versioned-bucket
erasure including delete markers; bounded-sweep starvation; two collectors on
one prefix; multi-host clock skew; credential expiry mid-run; fallback
resurrection; copy vs retention race.

Fake + MinIO parity does not certify AWS/R2/B2 — the certified provider gets a
one-off opt-in live check (`scripts/s3-smoke.ts`), never part of `verify`.
Contract-test **implementation** belongs to the implementation owner; R reviews
it (v1 wrongly assigned writing them to R, which has no implementation
ownership).

### 5.8 Migration and cutover

Keys are already `<aa>/<digest>`, so migration is a verified byte copy
(`scripts/blob-migrate.ts`, `--dry-run`, idempotent, per-object digest check).
v1's "read fallback for one release" was under-specified; as written it is
dangerous:

- copying while writers run misses late uploads → **quiesce writers**, then run
  a final reconciliation that reports zero un-copied referenced keys;
- during any fallback window, **erasure must hit both stores**, otherwise a
  retention job leaves bytes in the old volume (resurrection);
- rollback after cutover loses S3-only uploads unless the S3 store stays
  readable; define the rollback as "keep S3 as read source, never as second
  writer";
- backup/restore (docs/operations.md) currently stops writers, tars the
  attachments volume, dumps Postgres, and replays a signed redaction ledger.
  A bucket needs an equivalent: versioned bucket or a provider snapshot in the
  same quiesced window, same checksum manifest, and GC suspended during
  restore. **This document does not yet specify it, and it must be specified
  before cutover.**

### 5.9 Ownership and staging

| Slice                                                   | Owner            | Content                                                      |
| ------------------------------------------------------- | ---------------- | ------------------------------------------------------------ |
| Ports + config schema + capability probe                | A                | `packages/contracts`, `packages/config`, new `packages/blob` |
| FS adapter extracted from intake, behaviour unchanged   | A, C review      | intake re-exports only                                       |
| S3 adapter, reconciliation sweep, version-aware erasure | A                | `packages/blob`, worker entrypoint                           |
| Readiness + operations capacity                         | A                | `app/api/ready`, `product/operations.ts`                     |
| Call-site rewiring (6 files, incl. telegram webhook)    | A (may delegate) | intake, extensions, demo, telegram, worker                   |
| Migration script, docs, compose MinIO dev profile       | A                | `scripts/`, `docs/operations.md`, `compose*.yaml`            |
| Exact-tip adversarial review                            | R                | review only                                                  |

Crosses C and E lanes → needs an explicit A-scoped card with frozen interfaces
before implementation, per AGENTS.md.

## 6. Staged plan

1. Freeze ports (`PrivateBlobStore`, `BlobLifecycle`, error taxonomy, deadlines),
   config keys, deployment-namespace ownership check, and the contract suite.
   Filesystem adapter passes unchanged. No deploy-surface change.
2. Rewire the six call sites to the injected store; delete `root` plumbing.
   Filesystem only; `verify` stays green. Pure refactor, independently
   revertible.
3. S3 adapter: lowest-common-denominator API, fake-backed tests, opt-in MinIO
   live check, fail-closed startup probe.
4. Reconciliation sweep with per-key advisory lock + global reference check;
   version-aware erasure; wire into the worker beside the existing recovery
   sweep.
5. Readiness/capacity switch; docs; compose MinIO dev profile; production
   compose note that the attachments volume is unused in S3 mode (it stays
   declared because `volume-init` also prepares Caddy state; operators remove
   the mount in their own manifest).
6. Migration script, quiesced cutover, bucket backup/restore procedure.

Steps 1–2 are pure refactors and carry almost all of the risk reduction.

## 7. Unresolved before any code

1. **Certified provider** — AWS, MinIO (same host / managed), R2, other. Decides
   encryption, versioning and consistency stance. Cannot be "all four".
2. **Versioning policy** — required for erasure semantics and backup; default
   is "refuse versioned buckets".
3. **Bucket backup/restore** — must be specified (§5.8) before cutover, and is
   a bigger piece of work than the adapter.
4. **Orphan cleanup** — reconciliation-only (recommended, no migration) vs a DB
   intent table (tightens the crash window, adds a migration + second
   connection).
5. **Fallback window** — none (recommended: quiesced cutover) vs dual-read, and
   if dual-read, both-store erasure is mandatory.
6. **Default backend for new deployments** — filesystem (recommended, smallest
   blast radius) vs S3.
7. **Max object size** — config accepts any positive integer while the reader
   and eraser hard-cap at 10 MiB and `put` is a single PUT. Either enforce one
   ceiling end to end or add multipart; today it is inconsistent.

## 8. Verdict

The work is worth doing, but it is a storage-lifecycle change, not a "swap the
`fs` calls for `s3` calls" change. The blob adapter itself is small; erasure,
reconciliation, backup/restore and readiness carry the risk. Do steps 1–2 first
(pure refactor), then commit to exactly one certified provider.

## 9. What the adversarial pass changed

- Corrected: the attachment route already re-verifies bytes; settlement runs on
  success too; capacity is nullable by contract; the `.pending` spool exists
  only for process-crash recovery.
- Reversed: v1's reliance on an age threshold for GC safety. The digest
  advisory lock is the safety mechanism (verified in
  `blob-pruning.ts` and the upload paths). Age is hygiene only.
- Added: the production Telegram webhook call site; the
  configurable-`maxBytes` vs 10 MiB hard-cap inconsistency; exclusive
  deployment namespace for buckets; version-aware fail-closed erasure; IAM
  reality for `HeadBucket`; SSE non-portability; B2 consistency caveat;
  ListObjectsV2 paging/partial-response hazards; bucket backup/restore as a
  blocking prerequisite; R cannot implement contract tests.
- Weakened: v1 called the plan "recommended" in places where the review showed
  it was unsafe (cutover with fallback, metadata-based erase verification).
