# Milestone status

Updated 2026-11-07. Coordinator A owns this file. Current assignment: archive/review the user-supplied prototype and integrate its handoff into the plan. No later application implementation is authorized; task cards remain queued handoffs.

| Milestone | Status                          | Evidence / remaining gate                                                                                                                                                       |
| --------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0        | Complete — engineering baseline | Frozen install, Biome, strict type checks, 6 Vitest tests, Next/worker builds and local Compose smoke passed under Node 26.11.1. Contracts v1 reviewed/frozen by coordinator A. |
| M1        | Not started                     | Identity, tenant isolation and persistence                                                                                                                                      |
| M2        | Not started                     | First reviewed extraction; real provider smoke required                                                                                                                         |
| M3        | Not started                     | Imports, photos, Telegram                                                                                                                                                       |
| M4        | Not started                     | Reconciliation and policy gates                                                                                                                                                 |
| M5        | Not started                     | Delivery and escalation                                                                                                                                                         |
| M6        | Not started                     | Reports against independent oracle                                                                                                                                              |
| M7        | Not started                     | Production operations and release                                                                                                                                               |

## Current blockers and limits

No provider credentials or public endpoint are needed for M0. No business tables, authentication routes, migrations, seeds, queue handlers or workflows exist. Migration/seed commands explicitly report no operations. Production hosting, realistic scene-photo benchmarks and live model checks belong to later milestones. Contracts v1 are frozen for the scoped independent starts. Future additions/changes require coordinator review and versioned schemas before dependent consumers are implemented. See docs/tasks/README.md for parallel starts and dependencies.

## Ownership

A (current coordinator) completed P0-01 through P0-03. Later tasks are unclaimed. Owners claim isolated worktrees and report status through A. No parallel database resets or shared contract edits.

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
