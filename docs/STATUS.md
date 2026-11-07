# Milestone status

Updated 2026-11-07. Coordinator A owns this file. Current assignment: first-wave coordinator integration complete; B auth/tenant, D provider-free extraction and E visual foundation slices are reviewed and verified. Full M1/M2 workflows remain in progress. B/P1-01, D/P2-01 and E/P2-00 are assigned at 467e206; claims/progress live on the local board.

| Milestone | Status                                           | Evidence / remaining gate                                                                                                                                                       |
| --------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Complete — engineering baseline                  | Frozen install, Biome, strict type checks, 6 Vitest tests, Next/worker builds and local Compose smoke passed under Node 26.11.1. Contracts v1 reviewed/frozen by coordinator A. |
| M1        | In progress — P1-01 slice verified               | Auth/tenant schema and authorization factories integrated; public sign-in/reset/invitation/org-switcher/demo flows remain open.                                                 |
| M2        | Preparation — extraction/UI foundations verified | Provider-free adapter and visual primitives integrated; actual reviewed workflow/live model gate remain open.                                                                   |
| M3        | Not started                                      | Imports, photos, Telegram                                                                                                                                                       |
| M4        | Not started                                      | Reconciliation and policy gates                                                                                                                                                 |
| M5        | Not started                                      | Delivery and escalation                                                                                                                                                         |
| M6        | Not started                                      | Reports against independent oracle                                                                                                                                              |
| M7        | Not started                                      | Production operations and release                                                                                                                                               |

## Current blockers and limits

Integration now includes auth/tenant schema, migration/credential-free synthetic seed tooling, tenant authorization factories and a provider-free extraction/evaluator slice. Public sign-in/invitation/reset routes/UI, organization switching, ledger/outbox, worker processing and live model checks remain incomplete. No real model credentials or public endpoint were needed for these slices. Root quality checks remain database-free; PostgreSQL integration and browser suites are explicit separate gates. Full M1/M2 milestone acceptance remains open.

## Ownership

A (current coordinator) completed P0-01 through P0-03. B/P1-01, D/P2-01 and E/P2-00 implementation slices are reviewed/integrated; remaining tasks are unclaimed. Owners claim isolated worktrees and report status through A. No parallel database resets or shared contract edits.

## Validation evidence

- Fresh temporary checkout: `bun install --frozen-lockfile` and `bun run verify` both passed without existing node_modules or .next output. Type checking generates Next route types before tsc. Container build also installed from a clean dependency filesystem.
- `bun run verify` using Node 26.11.1: Biome with no warnings, strict root/web type checks, 3 test files / 6 tests, production Next build and Node worker artifact.
- At M0, `db:migrate` / `db:seed` were explicit no-ops. P1-01 now supplies real auth/tenant migrations and credential-free synthetic seeds; current verification is recorded below.
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

First handoff review: B submitted c0e28cc and D submitted 24f8e08; neither is accepted yet. A reproduced a privacy regression in D's validation envelope: provider-controlled item/evidence labels could copy raw source text into error field keys. D received a targeted revision request with a regression case and safe indexed-path requirement. B received the tested workspace dependency/export metadata and A is adding web's explicit ESM declaration for clean typed auth imports. E is working and has proposed FoundationPreview; A delegated only a development-gated synthetic preview page in its card so E can use the browser runner without editing production routes.

## Coordinator integration checkpoint — 2026-11-07

D/P2-01 accepted at 1b95923 after source/evidence/privacy review, independent hostile-identifier reproduction and a merged verify pass (38 tests). It is provider-free, with no real extraction accuracy or M2 gate claimed. B/P1-01 revised handoff 26e4a12 was then merged with history preserved. Combined `bun run verify` passed 8 files / 57 tests, Biome, strict types and Next/worker builds. A separately ran migration twice, seed twice (2/5/6 then 0/0/0) and the PostgreSQL suite (3 files / 24 tests) on its own relay-a-review project, port 59530, databases relay_a_review and relay_a_review_test. Worker databases were untouched. The quality CI job no longer invokes database commands without a database; an explicit PostgreSQL 18.1 migration/seed/integration job and test:integration script now cover them. CI YAML parsed locally; hosted CI was not run.

E submitted e4ae7b3 with presentation primitives/shells, synthetic development-only preview and 12 UI viewport cases; A is reviewing it separately. No full M1/M2 milestone is closed and no next worker task is automatically started.

Coordinator also excluded newly generated .pi/tasks runtime logs from Git/Biome and Docker contexts; project configuration files remain unaffected. These are local harness task artifacts, not source code or coordination authority.

E/P2-00 handoff e4ae7b3 is now integrated with B/D. Coordinator `bun run verify` passed 57 tests plus lint/types/Next/worker builds on all three slices. The actual Chromium suite passed 16/16 (four baseline + twelve UI cases), and an independent production server check confirmed /dev/foundation and its volunteer variant return 404 with no specimen content while health reports Node 26.11.1. A spot-checked generated desktop staff and narrow mobile volunteer screenshots; this is not full screen-reader/native-device/a11y certification. No authored files were changed outside the owners' slices. Formal task acceptance is recorded on the local board; no next task is automatically dispatched.

## Linear integration policy — 2026-11-07

A updated AGENTS.md, canonical worker/coordinator prompts and paste-ready launch files to require Conventional Commits and prohibit new merge commits. A chooses rebase plus fast-forward or squash based on branch quality; existing history is preserved. The local acceptance command now rejects merge commits in the integration range and records source/result SHAs, strategy and integration base. Rewritten integration requires an explicit base and identical aggregate binary diffs; conflicting/context-changing patches require a refreshed handoff. No product interfaces, migrations, dependencies or environment variables changed.

`bun run verify` passed under Node 26.11.1: Biome, strict root/web type checks, 60 tests and web/worker builds. Added temporary-repository tests cover squash and rewritten-commit mapping, unrelated-change rejection and merge-commit rejection. Existing board records remain readable; all three first-wave tasks are accepted and no questions are unanswered. PostgreSQL/browser suites were not rerun for this coordination-only change. A separate, stronger-model reviewer is recommended on demand for risky changes; no extra harness/session has been launched.
