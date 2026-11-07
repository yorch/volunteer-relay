# Worker self-service setup

Workers are authorized to create/resume their own task branch and linked worktree, install the pinned toolchain/dependencies, create ignored local configuration, and provision task-private local resources. A dispatches assignments and coordinates shared interfaces; A does not need to create your worktree for you. Setup is permitted before dispatch; application implementation still requires a matching assignment. This permission does not allow editing the coordinator checkout's tracked files or another worker's worktree. Respect harness sandbox approvals for Git metadata, sibling paths, the shared store, downloads and Docker; use the harness's normal approval mechanism when needed.

If you are coordinator A, use this section as the worker setup protocol; do not run the worker-specific steps or create worker resources yourself. Workers: read this section and your lane/task instructions before executing commands. Keep terminal commands in the target working directory: some harnesses start each command in the original directory, so set the tool's working-directory argument or explicitly `cd` every time. Do not rely on a previous shell's runtime activation or environment exports persisting.

## 1. Locate the checkout and activate the tools

Use the primary checkout supplied by the operator (currently `/Users/yorch/code/volunteer-relay`). Verify it with `git -C <primary> rev-parse --show-toplevel` and inspect `git -C <primary> worktree list --porcelain`. Do not clone a second repository: linked worktrees must share the Git common directory and communication store. A operates in the primary checkout and skips creation of a worker worktree.

Check Git, Node and Bun. Use **Node 26.11.1** and **Bun 1.4.1**, not whichever version happens to be the shell default. If the pinned Node is installed, activate it through the available runtime manager. With fnm, `fnm exec --using=26.11.1 <command>` also selects the correct runtime for one command and its children; for example `fnm exec --using=26.11.1 bun run verify`. This is useful when activation does not persist across harness tool calls. If absent, install the pinned Node with the installed manager (for example `fnm install 26.11.1`). Install a missing Bun 1.4.1 from its official package (`npm install --global bun@1.4.1` under the pinned Node) or the operator's approved package manager. Do not upgrade existing tools unnecessarily, execute an unknown remote installer, or bypass a permission rejection. Verify `node --version` and `bun --version` in the same execution environment that will run commands.

## 2. Discover the assignment and create/resume your worktree

Set your lane parameters using the launch prompt or this first-wave table. Paths are siblings of the primary checkout; if that directory is inaccessible, request normal write approval or agree a different path with A, rather than silently working on main.

| Agent | Task  | Branch         | Worktree basename | Web port | PostgreSQL port | Private Compose project |
| ----- | ----- | -------------- | ----------------- | -------- | --------------- | ----------------------- |
| B     | P1-01 | agents/B-P1-01 | volunteer-relay-B | 3101     | 55431           | relay-b-p1-01           |
| D     | P2-01 | agents/D-P2-01 | volunteer-relay-D | 3102     | 55432           | relay-d-p2-01           |
| E     | P2-00 | agents/E-P2-00 | volunteer-relay-E | 3103     | 55433           | relay-e-p2-00           |

C/F use the task assigned on the board and agree unused resource names/ports with A when activated. This table reserves first-wave conventions, not authority to start another task or a default database shared by workers.

From the primary checkout, run `node scripts/agents.mjs init` and `node scripts/agents.mjs board` under Node 26.11.1. The CLI needs no dependency installation to read the board. Set `RELAY_COORD_DIR` to the same absolute store path printed by init in every command/session (normally `<primary>/.relay-coordination`). Use the board assignment's exact `baseCommit` as `RELAY_BASE`. If there is no assignment yet, use the primary checkout's current committed HEAD for setup only; publish availability and finish environment preparation rather than waiting for A to create directories. Do not assign yourself a task.

Inspect branch/path registrations first. For a new branch and nonexistent worktree path:

```sh
git -C "$RELAY_PRIMARY" worktree add -b "$RELAY_BRANCH" "$RELAY_WORKTREE" "$RELAY_BASE"
```

If the branch already exists but is not checked out anywhere, inspect it, confirm it contains the assigned baseline, and attach it with `git -C "$RELAY_PRIMARY" worktree add "$RELAY_WORKTREE" "$RELAY_BRANCH"`. If the expected path already is the matching registered worktree, resume it. Verify its branch, Git common directory, `git status --short`, and `git merge-base --is-ancestor "$RELAY_BASE" HEAD`. Preserve all existing changes; do not force-add, reset, delete, prune or repurpose a path/branch checked out by another session. Report a genuine ownership/path collision to A. Never switch branches in the primary checkout to prepare your task.

Run subsequent commands from your worktree. When dispatch arrives after setup, read the assignment again and verify its exact baseCommit. If the branch needs a newer baseline, integrate that approved A commit from a clean worker branch (`git merge --ff-only <baseCommit>` for an untouched setup branch); for a diverged branch, coordinate a rebase of your own clean branch onto that approved commit. Never create a merge commit or discard existing work to force a match.

## 3. Install dependencies and create private configuration

From the worker worktree, run `bun install --frozen-lockfile`. A lock mismatch is a request to A, not permission to regenerate the lockfile. Read .env.example. Create `.env.local` and `.relay-local/attachments` in your own worktree; both are ignored by Git and Docker. Never copy production/provider credentials or another worker's configuration. The following Node snippet creates local configuration without printing its generated auth secret. Supply the lane parameters in your shell/command environment; if .env.local exists, inspect/validate its nonsecret settings without overwriting it.

```sh
node --input-type=module - "$RELAY_AGENT" "$RELAY_TASK" "$RELAY_WEB_PORT" "$RELAY_PG_PORT" "$RELAY_COMPOSE_PROJECT" <<'NODE'
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [agent, task, webPort, pgPort, project] = process.argv.slice(2);
if (!['B','C','D','E','F'].includes(agent) || !/^P\d-\d{2}$/.test(task ?? '') || !project ||
    ![webPort, pgPort].every(p => /^\d+$/.test(p ?? '') && Number(p) > 1024 && Number(p) <= 65535)) {
  throw new Error('Supply valid worker/task/resource parameters');
}
const database = `relay_${agent.toLowerCase()}_${task.toLowerCase().replaceAll('-', '_')}`;
mkdirSync('.relay-local/attachments', { recursive: true, mode: 0o700 });
if (existsSync('.env.local')) {
  console.log('Existing .env.local retained; validate its private resource settings without printing secrets.');
} else {
  const values = {
    DATABASE_URL: `postgres://relay:relay@127.0.0.1:${pgPort}/${database}`,
    TEST_DATABASE_URL: `postgres://relay:relay@127.0.0.1:${pgPort}/${database}_test`,
    APP_URL: `http://127.0.0.1:${webPort}`,
    BETTER_AUTH_SECRET: randomBytes(48).toString('hex'),
    ATTACHMENT_ROOT: resolve('.relay-local/attachments'),
    DEMO_MODE: 'false', TELEGRAM_TRANSPORT: 'replay', OPENAI_MONTHLY_BUDGET_CENTS: '0',
    RELAY_POSTGRES_PORT: pgPort, RELAY_WEB_PORT: webPort, RELAY_COMPOSE_PROJECT: project,
  };
  writeFileSync('.env.local', Object.entries(values).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join('\n')+'\n', { flag: 'wx', mode: 0o600 });
  console.log('Created ignored local configuration; no provider credentials enabled.');
}
NODE
```

Do not set NODE_ENV globally for all tools: Next build/dev and tests choose their proper environment. The Node scripts/worker do not themselves load this file; Bun may load dotenv files while dispatching, so do not rely on implicit behavior. For commands needing configuration, use Node's `--env-file=.env.local` explicitly, or export the specific needed variables in that command environment. Next environment loading is rooted at apps/web, not the root file created above, so use the explicit Node flag for the dev command too. Shell parameters such as RELAY_COORD_DIR must be repeated/persisted through the harness's normal environment mechanism.

## 4. Prepare only the local services your assigned slice needs

**B / P1-01:** Verify Docker/Compose are available and the daemon is running. Use your own project and PostgreSQL service; never start the whole shared stack or use a default project/port. From your worktree:

```sh
docker compose --project-name relay-b-p1-01 --env-file .env.local up -d --wait postgres
docker compose --project-name relay-b-p1-01 --env-file .env.local exec -T postgres psql -v ON_ERROR_STOP=1 -U relay -d postgres <<'SQL'
SELECT 'CREATE DATABASE relay_b_p1_01 OWNER relay'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'relay_b_p1_01')
\gexec
SELECT 'CREATE DATABASE relay_b_p1_01_test OWNER relay'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'relay_b_p1_01_test')
\gexec
SQL
docker compose --project-name relay-b-p1-01 --env-file .env.local exec -T postgres psql -v ON_ERROR_STOP=1 -U relay -d relay_b_p1_01 -c 'select 1'
docker compose --project-name relay-b-p1-01 --env-file .env.local exec -T postgres psql -v ON_ERROR_STOP=1 -U relay -d relay_b_p1_01_test -c 'select 1'
```

The Compose project's named database volume is private to B. The development and test database names are distinct; destructive test setup may target only the explicitly verified test database. If port 55431 is occupied, do not stop the occupant: choose an unused port, update DATABASE_URL, TEST_DATABASE_URL, RELAY_POSTGRES_PORT and the RELAY_PG_PORT parameter consistently in your ignored local setup, and report it to A. Initial migration/seed commands are Phase 0 no-ops; do not claim schema/auth acceptance from running them. Implement the real schema/migration tooling inside B's allowed package paths. A package-owned integration Vitest config (for example packages/db/vitest.integration.config.ts) may select B's tests/integration/auth suites without editing root config. Once such a config exists, invoke it under Node with --env-file=.env.local and make the tests explicitly use TEST_DATABASE_URL rather than silently fall back to DATABASE_URL. Record the actual command and checks. No integration coverage is implied by root Vitest.

**D / P2-01:** No PostgreSQL, real OpenAI key, Telegram, SMTP or background worker is required for the deterministic adapter/evaluation slice. Use synthetic inputs and provider-free adapters. Leave .env.local's reserved database URL unused; do not connect to the host's default database. Ask A for a dependency if the task needs one; do not edit manifests/lockfile. Request a scoped new assignment before starting real provider/worker orchestration.

**E / P2-00:** No database/auth/provider is required for the visual foundation. If you need a local preview, use your reserved port and explicit config from your worktree:

```sh
node --env-file=.env.local apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3103
```

Check whether the port is available; choose/report an alternative rather than stop someone else's server. Use the harness's available browser capabilities; if no browser or approved test runner is available, request that setup from A and continue independent component work. Do not add browser/Tailwind/font dependencies yourself or claim unrun viewport/accessibility checks. Do not expose the server outside localhost or edit root routes just to produce a preview outside your allowed paths.

For all workers: record nonsecret setup details in `.relay-local/setup.md` (worktree, branch, baseline, ports, project/database names, attachment path, commands/results and blockers). Send A a concise summary through the board. Do not create services you do not need. Never run `docker compose down -v`, a shared DB reset, or clean another worker's data. On handoff stop only your task-specific temporary processes if no longer needed; retain private database/attachment volumes and report how to resume them.

## 5. Verify, claim and start the scoped slice

Run `bun run verify` from your worktree under Node 26.11.1 before editing application code. If the baseline is broken outside your allowed paths, report the exact failure to A rather than redefine shared config. After setup, check board/inbox again. If no matching assignment exists, post your prepared worktree/resources and availability to A; setup is complete and only application implementation waits.

Once assigned, verify the exact baseline, claim using `bun run agents claim --agent <LANE> --task <ID>`, and post `working` status with setup/check results. If resuming, inspect the existing claim; reuse a matching stopped session's claim rather than creating a duplicate. Never run two harness sessions in the same claimed worktree. Post `blocked` plus a targeted question for a real missing service/tool/permission; continue independent in-scope work when possible. Application path ownership, review gates, progress polling and handoff rules below remain in force.
