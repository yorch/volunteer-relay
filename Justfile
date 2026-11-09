# Volunteer Relay developer recipes.
#
# `just` is optional convenience over the documented Node/Bun workflow: each
# recipe calls the same pinned Node 26.11.1 scripts, and README.md plus
# `bun run verify` remain the source of truth for gates and boundaries.
#
# The ignored .env.local is loaded into recipe environments when it exists;
# `just env` (also part of `just setup`) creates it and never overwrites it.

set dotenv-load
set dotenv-filename := ".env.local"

# Compose invocation that honours an isolated checkout's private project name.
dc := 'docker compose ${RELAY_COMPOSE_PROJECT:+--project-name "$RELAY_COMPOSE_PROJECT"}'

# List the available recipes.
[private]
default:
    @just --list

[private]
_pinned:
    @node -e 'if (process.versions.node !== "26.11.1") { console.error("Use Node 26.11.1; got " + process.versions.node); process.exit(1); }'
    @bun --version | grep -qx '1\.4\.1' || { echo "Use Bun 1.4.1; got $(bun --version)" >&2; exit 1; }

[private]
_require-env:
    @test -f .env.local || { echo "Missing .env.local; run 'just env' or 'just setup' first." >&2; exit 1; }

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

# Check the pinned toolchain, Docker, and the local configuration.
[group('Setup')]
[script("sh", "-eu")]
doctor:
    node_version="$(node --version)"
    [ "$node_version" = "v26.11.1" ] || { echo "Use Node 26.11.1; got $node_version" >&2; exit 1; }
    command -v bun >/dev/null 2>&1 || { echo "Bun 1.4.1 is not installed" >&2; exit 1; }
    bun_version="$(bun --version)"
    [ "$bun_version" = "1.4.1" ] || { echo "Use Bun 1.4.1; got $bun_version" >&2; exit 1; }
    command -v docker >/dev/null 2>&1 || { echo "Docker Compose is required for local services" >&2; exit 1; }
    docker compose version >/dev/null 2>&1 || { echo "Docker Compose is not available" >&2; exit 1; }
    docker info >/dev/null 2>&1 || { echo "The Docker daemon is not running" >&2; exit 1; }
    echo "node:  $node_version"
    echo "bun:   $bun_version"
    echo "just:  $(just --version | sed 's/^just //')"
    if [ -f .env.local ]; then
      echo "env:   .env.local present (ignored by Git)"
    else
      echo "env:   .env.local missing; run 'just env'"
    fi

# Install dependencies from the lockfile with Bun.
[group('Setup')]
install: _pinned
    bun install --frozen-lockfile

# Create ignored .env.local, generated local secrets and attachment storage.
[group('Setup')]
[script("sh", "-eu")]
env: _pinned
    umask 077
    mkdir -p .relay-local/attachments
    if [ -e .env.local ]; then
      echo ".env.local already exists; preserving it (this recipe never overwrites)."
      exit 0
    fi
    # Build the file completely under a temporary name, then rename it into
    # place, so an interrupted run never leaves a half-written .env.local.
    tmp=".env.local.tmp.$$"
    trap 'rm -f "$tmp"' EXIT
    cp .env.example "$tmp"
    ENV_TMP="$tmp" node -e 'const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto"); const file = process.env.ENV_TMP; const env = fs.readFileSync(file, "utf8").replace(/^ATTACHMENT_ROOT=.*$/m, "ATTACHMENT_ROOT=" + JSON.stringify(path.resolve(".relay-local/attachments"))); fs.writeFileSync(file, env + "\nBETTER_AUTH_SECRET=" + crypto.randomBytes(32).toString("hex") + "\nRETENTION_LEDGER_KEY=" + crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });'
    chmod 600 "$tmp"
    mv "$tmp" .env.local
    trap - EXIT
    echo "Created .env.local with generated local secrets and .relay-local/attachments."

# Full local setup: tools, dependencies, .env.local, services, test database and migrations.
[group('Setup')]
[script("sh", "-eu")]
setup:
    echo "== doctor =="
    just doctor
    echo "== install =="
    just install
    echo "== env =="
    just env
    echo "== services =="
    just services
    echo "== test database =="
    just testdb
    echo "== migrate =="
    just migrate
    echo
    echo "Local setup complete. Next: 'just dev' (web http://localhost:3000, Mailpit http://localhost:8025)."

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

# Start local PostgreSQL and Mailpit and wait for them to be healthy.
[group('Services')]
services: _require-env
    {{ dc }} up -d --wait postgres mailpit

alias up := services

# Stop the local development services; named volumes and data are retained.
[group('Services')]
down: _require-env
    {{ dc }} down

# Follow local service logs, optionally for one service.
[group('Services')]
logs service="": _require-env
    {{ dc }} logs --follow --tail=100 {{ if service == "" { "" } else { quote(service) } }}

# Run an arbitrary docker compose subcommand, e.g. `just compose ps`.
[group('Services')]
[positional-arguments]
[script("sh", "-eu")]
compose *args: _require-env
    exec docker compose ${RELAY_COMPOSE_PROJECT:+--project-name "$RELAY_COMPOSE_PROJECT"} "$@"

# Print the configured local web, health and Mailpit endpoints.
[group('Services')]
urls: _require-env
    @echo "web:     ${APP_URL:-http://localhost:3000}"
    @echo "health:  ${APP_URL:-http://localhost:3000}/api/health"
    @echo "mailpit: http://localhost:${RELAY_MAILPIT_UI_PORT:-8025}"

# Query the running web app health endpoint.
[group('Services')]
health:
    @curl --fail --silent --show-error "${APP_URL:-http://localhost:3000}/api/health"
    @echo

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

# Apply the ordered auth/tenant migrations using DATABASE_URL.
[group('Database')]
migrate: _pinned _require-env
    bun run db:migrate

# Add idempotent synthetic tenants, users and memberships (no credentials).
[group('Database')]
seed: _require-env
    bun run db:seed

# Provision the fictional demo accounts and rich product dataset (never production).
[group('Database')]
seed-demo: _pinned _require-env
    DEMO_MODE=true NODE_ENV=development bun run db:seed:demo

# Create a dedicated *_test database in the local Compose PostgreSQL.
[group('Database')]
[positional-arguments]
[script("sh", "-eu")]
testdb name="": _require-env
    if [ -n "$1" ]; then
      name="$1"
    elif [ -n "${TEST_DATABASE_URL:-}" ]; then
      name="${TEST_DATABASE_URL##*/}"
    else
      name=relay_test
    fi
    case "$name" in
      *_test) ;;
      *) echo "Database name must end in _test; got $name" >&2; exit 1 ;;
    esac
    case "$name" in
      *[!a-z0-9_]*) echo "Use lower-case letters, digits and underscores; got $name" >&2; exit 1 ;;
    esac
    existing="$({{ dc }} exec -T postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$name'" -U relay -d postgres)"
    if [ "$existing" = "1" ]; then
      echo "Database $name already exists in the local Compose PostgreSQL."
    else
      {{ dc }} exec -T postgres createdb -U relay "$name"
      echo "Created database $name in the local Compose PostgreSQL."
    fi

# Open psql on the local Compose PostgreSQL.
[group('Database')]
psql db="relay": _require-env
    {{ dc }} exec postgres psql -U relay -d {{ quote(db) }}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

# Run the Next web app and the worker together.
[group('Run')]
dev: _pinned _require-env
    bun run dev

# Run only the Next web app.
[group('Run')]
dev-web: _require-env
    bun run dev:web

# Run only the worker in watch mode.
[group('Run')]
dev-worker: _pinned _require-env
    bun run dev:worker

# Build the production web bundle and the worker artifact.
[group('Run')]
build:
    bun run build

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

# Run the Biome formatting/lint gate.
[group('Verify')]
check:
    bun run check

# Apply Biome fixes.
[group('Verify')]
format:
    bun run format

# Generate Next route types and type-check the root and web projects.
[group('Verify')]
typecheck:
    bun run typecheck

# Run the unit test suites.
[group('Verify')]
test:
    bun run test

# Run every required gate: Biome, typecheck, unit tests and production build.
[group('Verify')]
verify:
    bun run verify

# Run the package-owned PostgreSQL integration suites against TEST_DATABASE_URL.
[group('Verify')]
test-integration: _pinned _require-env
    bun run test:integration

# Run the sequential product acceptance suites against a dedicated *_test database.
[group('Verify')]
[positional-arguments]
[script("sh", "-eu")]
test-product name="relay_product_test": _pinned _require-env
    test -n "${TEST_DATABASE_URL:-}" || { echo "Set TEST_DATABASE_URL in .env.local (see .env.example)." >&2; exit 1; }
    name="$1"
    just testdb "$name"
    url="${TEST_DATABASE_URL%/*}/$name"
    TEST_DATABASE_URL="$url" bun run test:product:integration

# Install the Chromium build used by the browser suite.
[group('Verify')]
e2e-install:
    bun run test:e2e:install

# Run the Playwright browser suite at the configured viewports.
[group('Verify')]
test-e2e: _require-env
    bun run test:e2e

# Opt-in live-provider smoke check; read README.md before spending provider budget.
[group('Verify')]
test-live: _pinned _require-env
    bun run test:live-provider

# ---------------------------------------------------------------------------
# Agents
# ---------------------------------------------------------------------------

# Run the coordination CLI, e.g. `just agents board` or `just agents inbox --agent A`.
[group('Agents')]
[positional-arguments]
[script("sh", "-eu")]
agents *args:
    exec crewplane agents "$@"

# Show the shared local coordination board.
[group('Agents')]
board:
    crewplane agents board

# Serve the read-only coordination dashboard on loopback.
[group('Agents')]
dashboard:
    crewplane dashboard

# Run the shared board watcher.
[group('Agents')]
[positional-arguments]
[script("sh", "-eu")]
watch *args:
    exec crewplane monitor "$@"

# ---------------------------------------------------------------------------
# Maintenance
# ---------------------------------------------------------------------------

# Remove generated build and test output; keeps node_modules and local data.
[group('Maintenance')]
clean:
    rm -rf .next .next-e2e apps/web/.next apps/worker/dist coverage test-results playwright-report

# Check the Justfile is formatted without rewriting it.
[group('Maintenance')]
lint-just:
    just --fmt --check

# Rewrite the Justfile with canonical formatting.
[group('Maintenance')]
format-just:
    just --fmt
