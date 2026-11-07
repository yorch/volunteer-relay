# Volunteer Relay

Multi-organization volunteer operations, currently **Phase 0 only**. This baseline contains contracts, synthetic fixtures and runnable web/worker skeletons. Authentication, domain tables, extraction and volunteer workflows are future tasks. MIT licensed.

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

`bun run check`, `typecheck`, `test` and `build` are separate CI gates. `bun run verify` runs all four. Type checking generates Next route types first, so it works before the first build in a clean checkout. `bun run format` applies Biome fixes. `bun run dev:web` and `dev:worker` start individual applications. `bun run db:migrate` and `db:seed` are explicit no-ops until B lands the first schema. No demo accounts are created. Unit tests run without network secrets. PostgreSQL integration and browser suites will get separate commands when implemented; empty placeholder directories do not imply coverage.

Read [AGENTS.md](AGENTS.md), [status](docs/STATUS.md), [contracts](docs/CONTRACTS.md), [architecture decisions](docs/adr/0001-foundation.md), [compatibility evidence](docs/adr/0002-compatibility.md) and [task map](docs/tasks/README.md) before contributing. The manual fixture oracle is in `fixtures/expected-results.json`; expected results must never be regenerated from product output. Shared interface, manifest and environment changes are coordinator-owned.

## Design reference

The [interactive prototype](design/reference/prototype.html) is a standalone visual reference, not an implemented product workflow. Read its [usage notes](design/reference/README.md) and the [review/phase map](docs/design/prototype-review.md) before translating it. E starts with P2-00 visual primitives, then implements screens through the scoped task cards and existing phase gates.
