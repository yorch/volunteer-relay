# Volunteer Relay

Multi-organization volunteer operations, currently **foundation and first implementation slices**. This baseline contains contracts, synthetic fixtures, web/worker skeletons, an auth/tenant persistence slice and a provider-free extraction/evaluation slice. Public authentication routes/UI, the contribution ledger and volunteer workflows remain future work. MIT licensed.

## Local setup

Install Node **26.11.1**, Bun **1.4.1**, and Docker Compose. With fnm: `fnm use` after installing the version from `.node-version`. Node must be on PATH before invoking Bun scripts; Bun dispatches explicit Node processes and never runs the application or tests itself.

```sh
bun install --frozen-lockfile
bun run verify
docker compose up -d postgres mailpit
bun run dev
```

The web skeleton is at http://localhost:3000 and `/api/health` reports the actual Node runtime. The worker logs readiness and remains idle until terminated; there are no job handlers. Mailpit is at http://localhost:8025. Local database credentials are `relay:relay`, database `relay`; do not expose these services publicly. Environment defaults permit local startup; copy `.env.example` to `.env` only if needed and pass it to Node commands using Node's `--env-file` option, or export variables in your shell. No credentials are required for the skeleton. Node worker scripts do not automatically load `.env`.

To run the entire local stack in containers:

```sh
docker compose up --build -d --wait
curl --fail http://localhost:3000/api/health
docker compose exec -T postgres psql -U relay -d relay -c 'select 1'
docker compose logs worker
docker compose down
```

Use either host web/worker or container web/worker to avoid port conflicts. If a host port is occupied, set `RELAY_POSTGRES_PORT`, `RELAY_WEB_PORT`, `RELAY_MAILPIT_UI_PORT` or `RELAY_SMTP_PORT` in a Compose env file and pass `docker compose --env-file <path> ...`. Host-run processes must use matching DATABASE_URL/APP_URL/SMTP_PORT values; container-internal service ports stay fixed. Compose persists database and private attachment volumes; `down` retains data. The Dockerfiles install with Bun and launch with Node. Local Compose runs the Next development server with NODE_ENV=development; the image build also checks the production bundle. Production reverse proxy, migrations gating, backup and least-privilege deployment are deferred to M7.

## Commands and boundaries

`bun run check`, `typecheck`, `test` and `build` are separate CI gates. `bun run verify` runs all four. Type checking generates Next route types first, so it works before the first build in a clean checkout. `bun run format` applies Biome fixes. `bun run dev:web` and `dev:worker` start individual applications. `bun run db:migrate` applies the ordered auth/tenant schema using an explicit DATABASE_URL. `bun run db:seed` adds idempotent synthetic tenants/users/memberships with no password/account rows. No usable demo credentials are created. Unit tests run without network secrets. `bun run test:integration` uses the package-owned PostgreSQL config and requires an explicitly separate TEST_DATABASE_URL ending in _test; it never falls back to DATABASE_URL. Run it with configured environment variables or directly with Node --env-file. Browser checks run separately as described below.

Read [AGENTS.md](AGENTS.md), [status](docs/STATUS.md), [contracts](docs/CONTRACTS.md), [architecture decisions](docs/adr/0001-foundation.md), [compatibility evidence](docs/adr/0002-compatibility.md) and [task map](docs/tasks/README.md) before contributing. The manual fixture oracle is in `fixtures/expected-results.json`; expected results must never be regenerated from product output. Shared interface, manifest and environment changes are coordinator-owned.

## Design reference

The [interactive prototype](design/reference/prototype.html) is a standalone visual reference, not an implemented product workflow. Read its [usage notes](design/reference/README.md) and the [review/phase map](docs/design/prototype-review.md) before translating it. E starts with P2-00 visual primitives, then implements screens through the scoped task cards and existing phase gates.

## Running multiple agents

Start with one coordinator and three workers (B data/auth, D extraction, E UI). The [operating kit](docs/agents/README.md) provides shared guidelines, six copy/paste prompts, task dispatch/worktree setup, and a local question/progress board across harnesses. `bun run agents init`, `bun run agents prompt A`, and `bun run agents board` work without additional dependencies. Setup does not launch agents or implement later phases.

## Browser smoke checks

A provides the shared Chromium runner; E owns product UI specs. After `bun run test:e2e:install`, run `bun run test:e2e` for the current browser suite at 1440/1024/390/320px. These checks run separately from `bun run verify`. See tests/e2e/README.md for isolated ports, preview reuse and the limits of baseline smoke coverage.
