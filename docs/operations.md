# Single-host operations

This profile is a deployment starting point, not proof of production readiness. It runs a private PostgreSQL 18 database, a one-shot migration and runtime grants, the standalone web server, and the worker. It publishes **no ports**: public ingress and TLS belong to the Traefik instance already running on the host, which reaches `web` over an external `traefik` network. PostgreSQL and attachments have no published ports. The web and worker run as the image's unprivileged `node` user with read-only root filesystems; writable attachments are a named volume. The initialization container sets its ownership. The database volume and attachments must persist across upgrades. Do not use the development Compose file for production.

## Provision and start

For a first deployment onto a host that already runs Traefik, follow the [first-deployment preflight](deployment-preflight.md) instead: it orders these steps, adds pass/fail criteria and covers rollback. The steps below are the reference procedure it sequences.

1. Provision the host with Docker Engine and Compose v2, persistent encrypted storage, monitoring, backups and restricted administrative access. That host must already run Traefik with an external network named `traefik`, an entrypoint named `websecure` and a certificate resolver named `webcert`; this stack terminates no TLS and owns no certificate state. Set DNS for a domain you control to that host. Keep the environment file, Docker socket, volumes and backups private.
2. Deploy the images the release workflow already published to GHCR for the reviewed commit: `ghcr.io/<owner>/volunteer-relay-web` and `ghcr.io/<owner>/volunteer-relay-worker`. The `publish` job builds both targets from `infra/Dockerfile` (Node 26.11.1, Bun 1.4.1) for linux/amd64 and linux/arm64, and runs only after every gate passes on `main` or a `v*` tag. It tags `latest` and the branch name on the default branch, `sha-<commit>` for every published commit, and `X.Y.Z` / `X.Y` for release tags.

   Deploy by digest, never by tag. Resolve the digest of the `sha-<commit>` tag for the commit you reviewed and pin that value in the operator environment file:

   ```sh
   docker buildx imagetools inspect \
     "ghcr.io/<owner>/volunteer-relay-web:sha-$(git rev-parse --short=7 HEAD)"
   ```

   That digest is the multi-architecture index, so one value covers amd64 and arm64. Resolve the worker image the same way and confirm both come from the same commit. If the package is private, authenticate the host once with a token carrying `read:packages`; Compose then pulls with those credentials:

   ```sh
   printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u <user> --password-stdin
   ```

   Do not build the images on the deployment host: a locally built image has no reviewed release behind it and cannot match the published digests. On restricted networks supply the required trusted proxy CA to any networked build step without disabling TLS verification. Do not include secrets in build arguments or images.
3. Create the two host-only environment files, owned by the operator and mode `0600`, from the committed templates:

   ```sh
   install -d -m 0700 /etc/volunteer-relay
   install -m 0600 infra/production/production.env.sample /etc/volunteer-relay/production.env
   install -m 0600 infra/production/runtime.env.sample /etc/volunteer-relay/runtime.env
   ```

   Replace every `REPLACE_*` placeholder with unique high-entropy credentials; the templates are not usable credentials. Compose interpolates the operator file; web and worker receive only the runtime file. Keep both out of source control — `.gitignore` and `.dockerignore` exclude `*.env`. The runtime template leaves the secrets commented out on purpose: production refuses to start without `BETTER_AUTH_SECRET`, so a blind copy fails loudly instead of booting with a placeholder secret, and ledger export and redaction stay unavailable until `RETENTION_LEDGER_KEY` is set. `scripts/production-env.test.ts` keeps both templates in step with `compose.production.yaml` and the configuration schema. This profile assumes a dedicated PostgreSQL cluster: grants revoke default PUBLIC access to every connectable database. The bootstrap user owns and runs migrations; the separate runtime user must be a new, distinct role without owned objects or role memberships. The Postgres image only applies initial user/password/database variables to a new volume; changing the file alone does not rotate existing credentials.

   The proxy contract is fixed by the host: external network `traefik`, entrypoint `websecure`, certificate resolver `webcert`. Create the network once on the host if it is missing (`docker network create traefik`). `TRAEFIK_NAME` defaults to `relay` and scopes the router, service and compression middleware names; set it only if another stack on the same host already claims `relay`, because two routers sharing a name make Traefik drop both. This stack publishes no ports, so the host proxy must own 80/443, the DNS record and the certificate state.

   Configure provider credentials and budget only when approved and tested; missing extraction provider configuration leaves extraction disabled. Telegram is replay-only by default. Never use demo mode or synthetic credentials for production. Application configuration is defined in `packages/config/src/index.ts`; configure outbound SMTP and any optional provider separately and validate their actual transport behavior before relying on delivery.
4. From the checked-out release directory, set an explicit project name and absolute environment path:

   ```sh
   export COMPOSE_PROJECT_NAME=volunteer-relay-prod
   export RELAY_ENV_FILE=/etc/volunteer-relay/production.env
   docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml config --quiet
   docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml up -d
   docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml ps -a
   ```

   The migration container and subsequent runtime-grants container must exit successfully before web and worker start. The latter grants runtime CRUD on existing public tables and sequences and default privileges for future objects created by the migration owner. It restricts the runtime role to the application database and does not grant schema ownership, superuser, database creation or role creation. Keep migration ownership consistent across upgrades and rerun the grants gate after migration; for extensions or other schemas review grants explicitly. Use URL encoding for special characters in both database URLs. Do not enable SQL statement logging for the role setup because it includes the runtime password. To rotate the runtime password, stop application services, update both files consistently, rerun the grants gate, then restart. The proxy does not gate on application health: it routes to `web` as soon as the container joins the `traefik` network, so confirm `/api/ready` yourself before treating a deployment as live. Investigate failed migrations before restarting; do not bypass the gate. Check HTTPS certificate issuance in the host proxy, `/api/health`, sign-in and authorized workflows, worker logs, disk space and backup alerting. Health alone does not prove database connectivity, provider delivery or business workflow correctness. The web and worker have graceful stop periods; allow in-flight work to finish before maintenance.

## Private attachment storage

Private attachment bytes live behind `PrivateBlobStore` (`packages/blob`) and
only ever reach a client through the authorized attachment route, which
re-verifies the digest against the database row. Two backends are supported and
selected by configuration; there is no migration between them, so choose one at
install time.

- `BLOB_STORE=filesystem` (default): a persistent volume at `ATTACHMENT_ROOT`.
  Uploads are rejected below `2 x ATTACHMENT_MAX_BYTES` free space, and
  `GET /api/ready` fails under the same floor.
- `BLOB_STORE=s3`: any S3-compatible service. The reference implementation is
  versitygw (Apache-2.0, stateless, POSIX backend); MinIO Community Edition is
  archived upstream and is not a supported target. Only the
  lowest-common-denominator API is used (`PutObject`, `GetObject`, `HeadObject`,
  `DeleteObject`, `ListObjectsV2`, `HeadBucket`), so a service without
  conditional writes or checksum headers still works.

Configuration is fail-closed. `BLOB_STORE=s3` requires `S3_BUCKET`,
`S3_REGION` and `S3_DEPLOYMENT_ID`; credentials must be complete or absent (the
standard provider chain is used otherwise); a plaintext `S3_ENDPOINT` is refused
in production and requires `S3_ALLOW_INSECURE=true` in development. Never fall
back to local disk when object storage is misconfigured: bytes would spread
across hosts.

Bucket ownership is exclusive. Startup writes and verifies a
`.relay-deployment` marker; a bucket already claimed by a different
deployment ID refuses to serve writes. Never point two deployments at one
prefix: each one's orphan reconciliation could delete the other's evidence.

Operational differences from local disk:

- `GET /api/ready` probes the bucket and the deployment marker instead of
  `statfs`. `HeadBucket` needs `s3:ListBucket` in AWS IAM, so grant the web role
  that action on the bucket in addition to object actions.
- `availableStorageBytes` is `null` for object storage. Unknown stays unknown;
  it is never reported as zero. Provider quota failures surface as
  `DEPENDENCY_UNAVAILABLE`, not validation errors.
- Crash-recovery uses bucket reconciliation instead of the `.pending` intent
  spool: the worker enumerates a bounded page, takes the per-digest
  `blob:<key>` advisory lock, re-checks references globally, and only then
  erases. The digest lock — not object age — is the safety mechanism; the age
  floor (`S3_RECONCILE_MINIMUM_AGE_MS`) only avoids churn.
- Erasure verifies the stored bytes against the key digest before deleting, and
  confirms the object is gone. A versioned bucket keeps bytes behind delete
  markers, so it is refused unless `S3_ERASURE_MODE=versions` is set, which
  enumerates and deletes every version. A denied, locked or failing delete keeps
  the retention job open; it is never recorded as a completed erasure.
- Uploads happen inside the transaction that accepts the source, while holding
  the per-digest advisory lock. That is what makes crash compensation correct,
  but object-storage latency now extends the transaction and lock hold time.
  Keep bucket latency low (same region, no cross-continent endpoint), watch for
  lock waits, and do not raise transaction timeouts to mask slow storage.
- Least privilege: web needs `GetObject`, `PutObject`, and `DeleteObject`
  (uploads are compensated on rollback); worker additionally needs
  `ListBucket` and, in versions mode, `ListBucketVersions` and
  `DeleteObjectVersion`. Never grant `s3:*`.

For a local S3-compatible service, start the optional Compose profile and
bootstrap the bucket (both idempotent):

```sh
docker compose --profile s3 up -d objects
NODE_ENV=development BLOB_STORE=s3 S3_BUCKET=relay S3_REGION=us-east-1 \
  S3_ENDPOINT=http://127.0.0.1:7070 S3_ALLOW_INSECURE=true \
  S3_FORCE_PATH_STYLE=true S3_DEPLOYMENT_ID=local-dev \
  S3_ACCESS_KEY_ID=relaylocal S3_SECRET_ACCESS_KEY=relaylocaldevelopment \
  node scripts/s3-bootstrap.ts --smoke
```

`--check` only probes an existing bucket; `--smoke` also writes, reads, lists and
erases synthetic bytes. Neither is part of `bun run verify`, because both need a
live endpoint.

In production the bundled `compose.production.yaml` still mounts the
`attachments` volume on web and worker. With `BLOB_STORE=s3` nothing reads it —
`ATTACHMENT_ROOT` is unused — so the mount is inert, not a second source of
truth. Remove it in your own deployment manifest (or drop the volume) so it
cannot be mistaken for live storage, and remember that the bundled backup script
still archives that volume if the mount remains.

## Backup

Backups contain private source evidence, identity data and attachments. Encrypt them at rest and in transit, restrict access, retain according to policy, and regularly test restoration in a separate environment. The scripts require Docker access and an explicit project and environment file. Never point them at a shared or unintended project. The backup directory must not exist and is created with restrictive permissions. Check exit status; discard any incomplete directory.

For a consistent database/attachment pair, stop all writers and ingress, including any external or manually started writers, before starting the backup. The script checks only the Compose services it knows about. Maintenance causes downtime.

With `BLOB_STORE=s3` the bundled backup and restore scripts do not capture the bucket. In that mode take a bucket snapshot (or a bucket version checkpoint) inside the same quiesced window, keep the same checksum manifest discipline, suspend orphan reconciliation until the restore target is verified, and never restore a bucket into a prefix owned by another deployment. Rehearse that path before relying on it; the signed redaction ledger requirement below is unchanged.

```sh
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml stop web worker
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" RELAY_ENV_FILE="$RELAY_ENV_FILE" infra/production/backup.sh /secure/backups/relay-2026-01-01
# After confirming success, restart:
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml up -d
```

The backup contains a PostgreSQL custom dump, a tar archive of attachments, a deployment-wide signed redaction ledger and SHA-256 checksums. The files are captured sequentially while writers are stopped. The worker requires `RETENTION_LEDGER_KEY` (at least 32 characters) for ledger export and redaction; back up this stable signing key separately in the secret manager. Do not store it in the backup directory or commit it. A backup-time ledger is a historical snapshot and may omit later redactions. Checksums detect accidental corruption; they do not authenticate the backup. Protect and verify the backup's origin separately. Certificate state belongs to the host's Traefik (`acme.json`), not to this project: back it up and protect it as part of the host proxy. The environment file is also not in this backup; manage it separately.

## Restore and upgrade

Restore only a trusted backup into a **new**, isolated Compose project with a fresh PostgreSQL and attachments volume. Do not restore into a live project. The restore script refuses a nonempty database or attachments volume and never drops existing data; failure after database restoration may leave a partially restored target, so discard that isolated target and start over. It validates checksums and rejects links, special files and unsafe paths in the attachment archive; it is not a sandbox for untrusted archives. Use compatible PostgreSQL image and application release, and keep services and external writers stopped.

```sh
export COMPOSE_PROJECT_NAME=relay-restore-unique
export RELAY_ENV_FILE=/absolute/path/to/isolated-restore.env
export RELAY_REDACTION_LEDGER=/secure/ledgers/current-deployment-redactions.json
# Environment points to isolated credentials and project; never the live project.
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml up -d postgres volume-init
# Wait for postgres health and successful volume-init before restore.
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml ps -a
COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" RELAY_ENV_FILE="$RELAY_ENV_FILE" infra/production/restore.sh /secure/backups/relay-2026-01-01
```

`RELAY_REDACTION_LEDGER` must point to the **current deployment-wide signed ledger**, including redactions made after the database backup, and the isolated worker must have the same protected `RETENTION_LEDGER_KEY` used to sign it. A ledger from the old backup alone is not sufficient if later redactions exist. Obtain and protect a fresh `export-all` ledger before recovery, following the CLI below; preserve it independently of the older backup. The restore script verifies and replays this ledger after restoring the database and files, before the application starts. If it is missing, invalid, stale, signed with a different key, or replay fails, keep the target offline and resolve the gap; otherwise old evidence could be resurrected. Check the ledger freshness using your operational records: a signature verifies integrity, not recency.

For example, with all writers quiesced and the live database reachable, export to a new protected file outside the backup directory:

```sh
umask 077
set -C  # refuse to overwrite an existing file in this shell
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" -f compose.production.yaml run --rm -T --no-deps worker node scripts/retention.ts export-all --file - > /secure/ledgers/current-deployment-redactions.json
set +C
```

Validate row counts, representative authorization and attachment access in isolation before any cutover. Restore does not automatically start the application. Restore uses the bootstrap identity and omits ACLs; the script runs the runtime-grants gate and signed ledger replay on the isolated target. Apply any newer migrations and rerun the grants gate before starting web and worker, so the new cluster obtains its own runtime role and grants. Plan cutover, DNS, secrets and rollback with the operator; do not point the production domain at a test project. For upgrades, take and verify a quiesced backup, review migrations and compatibility, deploy pinned matching images, and verify health and workflows. A failed migration blocks startup; rollback may require a tested restore rather than an older image against a newer schema. Never run concurrent migrations or destructive resets against shared data.

## Evidence and remaining gates

A local synthetic rehearsal used two distinct Compose projects with PostgreSQL 18.1: a row and attachment survived backup and restore, and a second restore was refused for the nonempty target. A separate migrated PostgreSQL rehearsal confirmed runtime CRUD permissions on auth, source and processing tables, denial of table creation and denial of connection to the administrative database. Compose configuration and shell syntax were checked. An isolated production-style container rehearsal also exercised synthetic sign-up and email verification, operator provisioning, source intake, manual approval and reporting, and need acknowledgment. This does not verify a fresh public host, host Traefik certificate issuance or renewal, real SMTP/Telegram/OpenAI providers, production network egress, monitoring, disaster recovery cutover or production load. Complete these gates with appropriate access before public operation; do not infer delivery or acknowledgment from provider acceptance.
