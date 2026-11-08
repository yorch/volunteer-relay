# Single-host operations

This profile is a deployment starting point, not proof of production readiness. It runs a private PostgreSQL 18 database, a one-shot migration and runtime grants, the standalone web server, and the worker. It publishes **no ports**: public ingress and TLS belong to the Traefik instance already running on the host, which reaches `web` over an external `traefik` network. PostgreSQL and attachments have no published ports. The web and worker run as the image's unprivileged `node` user with read-only root filesystems; writable attachments are a named volume. The initialization container sets its ownership. The database volume and attachments must persist across upgrades. Do not use the development Compose file for production.

## Provision and start

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

## Backup

Backups contain private source evidence, identity data and attachments. Encrypt them at rest and in transit, restrict access, retain according to policy, and regularly test restoration in a separate environment. The scripts require Docker access and an explicit project and environment file. Never point them at a shared or unintended project. The backup directory must not exist and is created with restrictive permissions. Check exit status; discard any incomplete directory.

For a consistent database/attachment pair, stop all writers and ingress, including any external or manually started writers, before starting the backup. The script checks only the Compose services it knows about. Maintenance causes downtime.

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
