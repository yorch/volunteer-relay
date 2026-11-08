# Volunteer Relay

Multi-organization volunteer operations for receiving updates, preserving evidence, reviewing proposals, tracking needs and reporting approved contributions. The product includes text, photo, import and Telegram intake; staff review and reconciliation; routing and delivery; reports; and retention controls. See [status](docs/STATUS.md) for verification and open deployment gates. MIT licensed.

## Local setup

Install Node **26.11.1**, Bun **1.4.1**, and Docker Compose. With fnm: `fnm use` after installing the version from `.node-version`. Node must be on PATH before invoking Bun scripts; Bun dispatches explicit Node processes and never runs the application or tests itself.

For a fresh host-run development setup, use an isolated local database. The following creates `.env.local` only if it does not already exist, generates a private auth secret and retention signing key, and keeps attachments in this checkout's ignored local directory:

```sh
bun install --frozen-lockfile
umask 077
if [ -e .env.local ]; then echo ".env.local already exists; preserve it and configure it manually" >&2; exit 1; fi
cp .env.example .env.local
mkdir -p .relay-local/attachments
node -e 'const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto"); const file = ".env.local"; const env = fs.readFileSync(file, "utf8").replace(/^ATTACHMENT_ROOT=.*$/m, "ATTACHMENT_ROOT=" + JSON.stringify(path.resolve(".relay-local/attachments"))); fs.writeFileSync(file, env + "\nBETTER_AUTH_SECRET=" + crypto.randomBytes(32).toString("hex") + "\nRETENTION_LEDGER_KEY=" + crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });'
docker compose up -d --wait postgres mailpit
node --env-file=.env.local packages/db/src/migrate.ts
node --env-file=.env.local scripts/run.mjs dev
```

Run `bun run verify` separately for the code checks. The web app is at http://localhost:3000, `/api/health` reports the actual Node runtime, and Mailpit is at http://localhost:8025. Local Compose database credentials are `relay:relay`, database `relay`; do not expose these services publicly. Node worker scripts do not automatically load `.env.local`: use `node --env-file=.env.local` or export the required variables. Keep the generated file private and never use its development secrets in production. Model extraction and external channels require their own configuration; see `.env.example`. For synthetic demo accounts and a separate product integration test database, follow [demo guidance](docs/demo.md).

The development Compose file also defines container web and worker services, but they require explicit application environment configuration and migrations before authenticated use. The host-run commands above start only Compose PostgreSQL and Mailpit; use the [production profile](docs/operations.md) for a production-style topology.

Use either host web/worker or container web/worker to avoid port conflicts. If a host port is occupied, set `RELAY_POSTGRES_PORT`, `RELAY_WEB_PORT`, `RELAY_MAILPIT_UI_PORT` or `RELAY_SMTP_PORT` in a Compose env file and pass `docker compose --env-file <path> ...`. Host-run processes must use matching DATABASE_URL/APP_URL/SMTP_PORT values; container-internal service ports stay fixed. Compose persists database and private attachment volumes; `down` retains data. The Dockerfiles install with Bun and launch with Node. Local Compose builds the unpublished `dev` target (full workspace, Next development server, NODE_ENV=development) for web and the slim production `worker` target. The separate [production profile](docs/operations.md) provides Caddy, migration gating, private storage and backup/restore; fresh-host and live-provider gates remain open.

### Published images

CI publishes multi-architecture (linux/amd64, linux/arm64) images to GitHub Container Registry after all gates pass: `ghcr.io/yorch/volunteer-relay-web` and `ghcr.io/yorch/volunteer-relay-worker`. Tags are `latest` and `main` for the default branch, `sha-<commit>` for every published commit, and `X.Y.Z` / `X.Y` for `vX.Y.Z` release tags. Images run as the unprivileged `node` user: the web image is the Next standalone server (port 3000), and the worker image carries the production workspace dependencies and operational scripts. Both expect the same environment as Compose (`DATABASE_URL` and the variables in `.env.example`); production mode requires `BETTER_AUTH_SECRET`. Publication is not evidence that a fresh host, TLS or external providers have been validated.

```sh
docker pull ghcr.io/yorch/volunteer-relay-web:latest
docker pull ghcr.io/yorch/volunteer-relay-worker:latest
```

## Commands and boundaries

`bun run check`, `typecheck`, `test` and `build` are separate CI gates. `bun run verify` runs all four. Type checking generates Next route types first, so it works before the first build in a clean checkout. `bun run format` applies Biome fixes. `bun run dev:web` and `dev:worker` start individual applications. `bun run db:migrate` applies the ordered auth/tenant schema using an explicit DATABASE_URL. `bun run db:seed` adds idempotent synthetic tenants/users/memberships with no password/account rows. No usable demo credentials are created. Unit tests run without network secrets. `bun run test:integration` uses the package-owned PostgreSQL config and requires an explicitly separate TEST_DATABASE_URL ending in _test; it never falls back to DATABASE_URL. Run it with configured environment variables or directly with Node --env-file. Browser checks run separately as described below.

`bun run test:product:integration` runs the product PostgreSQL suites sequentially. Set `TEST_DATABASE_URL` to a dedicated disposable PostgreSQL database whose name ends in `_test`; these tests modify and truncate their test database. Never point them at shared or production data. `bun run test:live-provider` is a separate opt-in synthetic English, Spanish and photo smoke check that may incur provider charges and writes synthetic budget/tenant records to its configured database. It refuses to run unless `RUN_LIVE_PROVIDER_CHECK=true` and model, pricing, token limits and budget are configured; use an isolated database and never put provider secrets in the repository. The check is not part of ordinary verification. See [product task evidence](docs/tasks/PRODUCT-IMPLEMENTATION.md) for scope and limits.

For a populated private demo, use the opt-in `db:seed:demo` command and [demo walkthrough](docs/demo.md). It provisions fictional role accounts, seven review scenarios, private synthetic photo evidence, a 180-minute approved ledger, pending contributions, needs, and delivery examples. It refuses production and preserves later edits on rerun. Ordinary `db:seed` remains credential-free.

To provision a new organization for an existing verified account, use the operator-only CLI documented in [provisioning](docs/provisioning.md); it does not create a password or promote an existing tenant member. Follow the signed current redaction-ledger requirements in [operations](docs/operations.md) when backing up or restoring.

Read [AGENTS.md](AGENTS.md), [status](docs/STATUS.md), [contracts](docs/CONTRACTS.md), [architecture decisions](docs/adr/0001-foundation.md), [compatibility evidence](docs/adr/0002-compatibility.md) and [task map](docs/tasks/README.md) before contributing. The manual fixture oracle is in `fixtures/expected-results.json`; expected results must never be regenerated from product output. Shared interface, manifest and environment changes are coordinator-owned.

## Design reference

The [interactive prototype](design/reference/prototype.html) is a standalone visual reference, not an implemented product workflow. Read its [usage notes](design/reference/README.md) and the [review/phase map](docs/design/prototype-review.md) before translating it. The production screens share its palette and general shell, but full layout and UX parity remains open. See the [current comparison and screenshots](docs/design/product-parity.md) and [design follow-up task](docs/tasks/P2-06.md). The prototype remains reference-only and does not supply product data.

## Running multiple agents

Start with one coordinator and three workers (B data/auth, D extraction, E UI). The [operating kit](docs/agents/README.md) provides shared guidelines, six copy/paste prompts, task dispatch/worktree setup, and a local question/progress board across harnesses. `bun run agents init`, `bun run agents prompt A`, and `bun run agents board` work without additional dependencies. Setup does not launch agents or implement later phases.

## Browser smoke checks

After `bun run test:e2e:install`, run `bun run test:e2e` for the current browser suite at 1440/1024/390/320px. These checks run separately from `bun run verify`. See [browser verification](tests/e2e/README.md) for isolated ports, preview reuse and test coverage limits.
