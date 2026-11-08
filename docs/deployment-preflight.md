# First-deployment preflight (VPS behind an existing Traefik)

An ordered checklist for taking the production profile to a host that already runs
Traefik. It sequences and gates the procedures in [operations.md](operations.md); it does
not replace them, and it is not evidence that any of it has run.

Every step has a pass criterion. Stop at the first failure rather than continuing: the
migration and runtime-grants gates exist so that a half-started stack is never reachable.

## 0. Decide before you start

These are hard to change later, so decide deliberately rather than by default — though
none of them is permanent.

- [ ] **Storage backend.** `BLOB_STORE=filesystem` (default, a volume) or `BLOB_STORE=s3`
  (object storage). Switching later is supported, but it is a quiesced, verified cutover
  with a byte-verification gate rather than a config flip — see
  [Migrating between backends](operations.md#migrating-an-existing-deployment-between-backends).
  A bucket is claimed exclusively by `S3_DEPLOYMENT_ID`; two deployments must never
  share a prefix.
- [ ] **Deployment name.** `TRAEFIK_NAME` defaults to `relay`. If anything else on that
  Traefik already uses `relay`, choose another value now — two routers sharing a name
  make Traefik drop **both**.
- [ ] **Domain.** `RELAY_DOMAIN` is the hostname the proxy will route and certify. It must
  match the DNS record exactly.

If you chose `s3`, also decide to drop the `attachments` volume mounts from your
deployment manifest: with object storage `ATTACHMENT_ROOT` is unused, and `backup.sh`
still archives that (empty, inert) volume if the mount remains.

## 1. Host prerequisites

- [ ] Docker Engine with Compose v2; a Compose new enough for the merge features this
  profile relies on (`docker compose version`).
- [ ] Traefik already running, with: external network `traefik`, entrypoint `websecure`,
  certificate resolver `webcert`, Docker provider watching. Verify, do not assume:

      ```sh
      docker network inspect traefik --format '{{.Name}} {{.Driver}}'
      docker inspect <traefik-container> --format '{{json .Args}}' | tr ',' '\n' | grep -E 'entrypoints|certresolvers'
      ```

- [ ] `docker network inspect traefik` reports an existing network. If it is missing,
  create it once (`docker network create traefik`) **before** the first start; an
  external network that does not exist makes Compose refuse to start.
- [ ] Inbound TCP 80/443 reachable on the host (owned by Traefik, not by this stack).
  Nothing in this profile publishes a port.
- [ ] Persistent storage for the PostgreSQL volume, sized for the database **and**
  `2 x ATTACHMENT_MAX_BYTES` of free space if using the filesystem backend — uploads
  are rejected below that floor and `/api/ready` fails under it.
- [ ] Encrypted backups location, and monitoring/alerting for disk and container health.
- [ ] Host clock synchronised (certificate validation and session expiry both depend on it).
- [ ] Registry access: if the GHCR package is private, authenticate once with a token that
  has `read:packages`:

      ```sh
      printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u <user> --password-stdin
      ```
## 2. Pick the release and pin digests

- [ ] Choose the reviewed commit on `main` (or a `v*` tag) whose CI run passed **all** gates
  — `publish` only runs after `quality`, `compose`, `browser` and `postgres-integration`.
  A skipped `publish` means there are no images for that commit; do not deploy a build
  from your machine instead.
- [ ] Resolve the digest of that commit's `sha-<commit>` tag for both images:

      ```sh
      docker buildx imagetools inspect \
        "ghcr.io/<owner>/volunteer-relay-web:sha-<commit>" --format '{{json .Manifest.Digest}}'
      docker buildx imagetools inspect \
        "ghcr.io/<owner>/volunteer-relay-worker:sha-<commit>" --format '{{json .Manifest.Digest}}'
      ```

- [ ] Record both digests and the commit SHA next to the change record. The digest is the
  multi-architecture index, so one value serves amd64 and arm64.
- [ ] Confirm both images came from the **same** commit. A web/worker pair from different
  commits can disagree about migrations.

## 3. Environment files

- [ ] `install -d -m 0700 /etc/volunteer-relay`, then install both templates mode `0600`
  from `infra/production/*.env.sample`.
- [ ] Every `REPLACE_*` placeholder replaced; no placeholder survives into the deployment.
- [ ] `POSTGRES_*` (bootstrap, runs migrations) and `RELAY_RUNTIME_*` (application) are
  **different** credentials, and the runtime role is a new role with no owned objects.
- [ ] `RELAY_WEB_IMAGE` / `RELAY_WORKER_IMAGE` hold the digests from step 2, not tags.
- [ ] `BETTER_AUTH_SECRET` and `RETENTION_LEDGER_KEY` set (each ≥32 chars) and stored in the
  secret manager. The app refuses to start without the first; ledger export and
  redaction stay unavailable without the second.
- [ ] If `BLOB_STORE=s3`: `S3_BUCKET`, `S3_REGION`, `S3_DEPLOYMENT_ID`, an https
  `S3_ENDPOINT`, and credentials as a complete pair or absent.
- [ ] Render before starting:

      ```sh
      docker compose --project-name "$COMPOSE_PROJECT_NAME" \
        --env-file "$RELAY_ENV_FILE" -f compose.production.yaml config --quiet
      ```

      Pass: exits 0. Then confirm nothing publishes a port and the router labels resolved:

      ```sh
      docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" \
        -f compose.production.yaml config | grep -E 'published|traefik.http.routers|Host\('
      ```

      Pass: no `published:` entry, one `Host(...)` with your domain, `webcert` as resolver.
## 4. First start

Start in dependency order and watch each gate; `web` and `worker` are gated on the one-shot
containers, so a failure must stop the deployment, not be retried blindly.

- [ ] `up -d postgres volume-init` — pass: `postgres` healthy, `volume-init` exited 0.
- [ ] `up -d migrate` — pass: exits 0. A failed migration blocks everything after it.
- [ ] `up -d runtime-grants` — pass: exits 0.
- [ ] `up -d web worker` — pass: `web` healthy, `worker` running.

```sh
docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$RELAY_ENV_FILE" \
  -f compose.production.yaml ps -a
```

- [ ] Every one-shot container shows `Exited (0)`; nothing is restarting.

## 5. Verification

Run these in order. Each is a gate: do not declare the deployment live on a partial pass.

| #   | Check                 | Command                                                 | Pass criterion                                                                        |
| --- | --------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Router registered     | Traefik dashboard/API, or `docker logs <traefik>`       | one enabled router for your `Host()`, no provider errors, no "dropped" router warning |
| 2   | Nothing published     | `docker compose ... ps --format '{{.Name}} {{.Ports}}'` | empty ports column for every service                                                  |
| 3   | Database not exposed  | from another host: `nc -z <vps> 5432`                   | refused/timeout                                                                       |
| 4   | Certificate issued    | `curl -sI https://$RELAY_DOMAIN`                        | valid chain for the domain, HTTP/2, 200 or 3xx                                        |
| 5   | Liveness              | `curl -fsS https://$RELAY_DOMAIN/api/health`            | 200                                                                                   |
| 6   | Readiness             | `curl -fsS https://$RELAY_DOMAIN/api/ready`             | 200 — proves DB and storage, not just a live process                                  |
| 7   | HTTP redirect         | `curl -sI http://$RELAY_DOMAIN`                         | 301/308 to https                                                                      |
| 8   | Sign-in               | browser, real account                                   | sign-in, organization switch, one authorized page                                     |
| 9   | Attachment round trip | upload a synthetic source, then fetch it                | bytes match; unauthorized fetch denied                                                |
| 10  | Worker                | `docker logs` on the worker                             | no crash loop, no repeated provider/storage errors                                    |
| 11  | Restart durability    | `docker compose ... restart web worker`                 | `/api/ready` returns 200 again; data still present                                    |

If using `s3`, add: the bucket contains the `.relay-deployment` marker for this
`S3_DEPLOYMENT_ID`, and a second deployment pointed at the same prefix is refused.

## 6. Backup rehearsal (before you need it)

- [ ] Stop writers, take a backup, restart, and confirm the archive verifies:

      ```sh
      docker compose ... -f compose.production.yaml stop web worker
      COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" RELAY_ENV_FILE="$RELAY_ENV_FILE" \
        infra/production/backup.sh /secure/backups/relay-$(date +%F)
      docker compose ... -f compose.production.yaml up -d
      (cd /secure/backups/relay-$(date +%F) && sha256sum -c SHA256SUMS)
      ```

- [ ] `RELAY_REDACTION_LEDGER` exported and stored **outside** the backup directory.
  `restore.sh` refuses to run without the current deployment-wide ledger.
- [ ] If `BLOB_STORE=s3`, note that `backup.sh` does not cover the bucket. Versioning and a
  bucket restore rehearsal are your responsibility.

## 7. Rollback

- [ ] Previous digests recorded in step 2, ready to re-pin.
- [ ] Understood: an older image against a newer schema may not work. A failed migration
  usually needs a restore, not a downgrade.
- [ ] `docker compose ... down` removes the containers and therefore the Traefik router;
  the domain will 404 from the proxy until something is running again.

## What this preflight does not establish

Edge hardening is **not** included, by explicit decision: this deployment ships with the same
posture the bundled Caddy had — HTTPS redirect and compression only, with no HSTS, no baseline
security headers, no body-size cap and no rate limiting on the auth endpoints. That is an
accepted risk for the first deployment, tracked as [P7-07](tasks/P7-07.md), not an oversight.

Passing every box above still does not verify: real SMTP/Telegram/OpenAI provider
behaviour, certificate **renewal** (only issuance), load and concurrency limits, disaster
recovery against a fresh host, or that the host's Traefik is correctly configured for any
other application on it. Those are separate gates with their own evidence.
