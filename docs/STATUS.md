# Milestone status

Updated 2026-11-07. Coordinator A owns this file. Current assignment: coordinator A dispatched the first wave and completed P0-08 shared browser tooling; worker implementation/handoffs remain in progress. B/P1-01, D/P2-01 and E/P2-00 are assigned at 467e206; claims/progress live on the local board.

| Milestone | Status                          | Evidence / remaining gate                                                                                                                                                       |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Complete — engineering baseline | Frozen install, Biome, strict type checks, 6 Vitest tests, Next/worker builds and local Compose smoke passed under Node 26.11.1. Contracts v1 reviewed/frozen by coordinator A. |
| M1        | In progress — B/P1-01 claimed   | Identity/tenant persistence implementation underway; no acceptance gate passed yet.                                                                                             |
| M2        | Preparation — D/E assigned      | Provider-free extraction and visual foundation only; reviewed workflow/live smoke still pending.                                                                                |
| M3        | Not started                     | Imports, photos, Telegram                                                                                                                                                       |
| M4        | Not started                     | Reconciliation and policy gates                                                                                                                                                 |
| M5        | Not started                     | Delivery and escalation                                                                                                                                                         |
| M6        | Not started                     | Reports against independent oracle                                                                                                                                              |
| M7        | Not started                     | Production operations and release                                                                                                                                               |

## Current blockers and limits

No provider credentials or public endpoint are needed for M0. No business tables, authentication routes, migrations, seeds, queue handlers or workflows exist. Migration/seed commands explicitly report no operations. Production hosting, realistic scene-photo benchmarks and live model checks belong to later milestones. Contracts v1 are frozen for the scoped independent starts. Future additions/changes require coordinator review and versioned schemas before dependent consumers are implemented. See docs/tasks/README.md for parallel starts and dependencies.

## Ownership

A (current coordinator) completed P0-01 through P0-03. First-wave B/P1-01, D/P2-01 and E/P2-00 are assigned; remaining tasks are unclaimed. Owners claim isolated worktrees and report status through A. No parallel database resets or shared contract edits.

## Validation evidence

- Fresh temporary checkout: `bun install --frozen-lockfile` and `bun run verify` both passed without existing node_modules or .next output. Type checking generates Next route types before tsc. Container build also installed from a clean dependency filesystem.
- `bun run verify` using Node 26.11.1: Biome with no warnings, strict root/web type checks, 3 test files / 6 tests, production Next build and Node worker artifact.
- `bun run db:migrate` / `bun run db:seed`: explicit no-ops, no schema or demo accounts introduced.
- `docker compose up --build -d --wait`: both images built. Default host port 5432 was occupied by an existing service; made ports configurable and repeated startup with POSTGRES=59432, WEB=59300, MAILPIT UI=5925, SMTP=59125. Existing services were untouched.
- Compose web health: `{status:"ok",service:"web",runtime:"26.11.1"}`; worker readiness reports Node 26.11.1. Drizzle/pg `select 1` returns 1; database identifies as PostgreSQL 18.1. Local Compose uses Next dev with matching development environment; container image builds verify the production bundle.
- Built worker started and terminated cleanly on SIGTERM. Temporary stack stopped after verification; persistent named volumes retained.
- GitHub Actions is configured with matching quality/build gates and a Compose smoke job; hosted CI has not been run from this local commit.

Oracle totals are independent expected results, not a claim that a product extraction/reporting pipeline exists. Minimal color PNGs only validate attachment integrity and unknown-evidence behavior. M1–M7 gates remain unfulfilled.

## Prototype reference handoff — 2026-11-07

Preserved design/reference/prototype.html as submitted, with usage notes, ADR 0003 and docs/design/prototype-review.md. A owns this reference/planning integration. E's next independent task is P2-00 (visual foundation), followed by the updated P2-02; P3-04, P5-03 and P6-01 map later screens to their original phase/service gates. Contracts, package dependencies, canonical fixtures and application behavior are unchanged.

Source review and Node 26 stubbed-DOM execution covered all seven page-render functions. Reproduced shared-visit undercount, first-session reset aliasing and selection/filter inconsistency; duration defaults and role/tenant gaps are documented. Browser host unavailable: actual visual/responsive/accessibility verification remains a UI acceptance dependency. The reference path alone is excluded from Biome to preserve its original bytes; production translations remain subject to all checks. No live integrations or browser acceptance are claimed by this commit.

Prototype handoff verification: `bun run verify` passed (Biome, generated Next route types, strict type checks, six existing tests, web/worker builds); `git diff --check` passed. Application code, dependencies and lockfile are unchanged. Temporary review server stopped.

## Agent orchestration setup — 2026-11-07

A owns P0-06. Recommended initial concurrency: A + B(P1-01) + D(P2-01) + E(P2-00), with C/F standby and later rotation. Added docs/agents common/lane prompts, operating instructions, ADR 0004 and a Node-only local CLI for assignment, exclusive claim, progress, threaded questions/answers, ready handoffs and coordinator acceptance. Live board state is ignored and shared across linked worktrees; durable scope/decisions remain tracked. Product contracts, dependencies, fixtures and migrations are unchanged. Verification passed; no application assignments have been issued.

P0-06 verification: `bun run verify` passed with four test files / eleven tests (including five coordination scenarios), strict type checks, Biome and web/worker builds. Temporary Git repositories/worktrees verified a concurrent claim race, shared discovery, threaded answers, one active lane assignment, worktree/owner checks, dirty handoff rejection, accepted-commit ancestry and abandoned-task archive/reassignment. `bun install --frozen-lockfile` made no changes. Real local init/board/inbox commands succeeded with an empty board; Git ignores the store and Docker excludes it. No real application task was assigned, no provider was called, and no external messages were sent.

## Self-service worker bootstrap — 2026-11-07

Updated worker launch prompts and the canonical CLI prompt output to include complete self-service setup: safe branch/worktree creation/resume, pinned tool activation/install, board discovery, ignored private environment/secrets/attachments, B-only private PostgreSQL development/test databases, D's provider-free setup, E's isolated preview port, baseline verification and claim/handoff steps. Workers may prepare environments before dispatch; A retains assignment/shared-interface ownership. No application harness is launched by updating these instructions. `bun run verify` passed (eleven tests, Biome, strict type checks, web/worker builds). All embedded shell blocks passed zsh syntax checks; the Node environment generator was exercised in a temporary directory and verified for distinct DB URLs, secret generation, 0600 file mode, attachment-directory creation and preservation of an existing file on resume. No real worker worktrees or database services were created by this prompt update.

## First-wave dispatch — 2026-11-07

A published B/P1-01, D/P2-01 and E/P2-00 assignments at exact baseline 467e2060cba3e34d9e4989c5b3cd8c9888b119b8 and sent startup updates. All three linked worktrees exist. M1/M2 acceptance remains open: assignment is not completion. D's first slice is approved as a package-owned, provider-free adapter/evaluator with independently authored injected responses; matching algorithms remain deferred. A owns P0-08 browser runner setup to unblock E; no edits to worker-owned components/domain files.

P0-08 local verification: Playwright 1.65.0 engine metadata permits Node >=20; matching Chromium binaries installed successfully. Four actual Chromium baseline viewport tests passed under Node 26.11.1 (1440/1024/390/320), separate from eleven existing unit/coordination tests. B's workspace dependency and auth subpath request is approved: web declares @relay/domain and the domain package exports @relay/domain/auth at ./auth/src/index.ts; B must supply its owned barrel/implementation before auth is wired into main. Role CHECKs, live-role/removal semantics and human-permission denial for system actors were confirmed; invitation role validation and full M1 gates remain open. Next-generated environment declarations are untracked/ignored per installed Next documentation so browser runs do not dirty handoff worktrees.
