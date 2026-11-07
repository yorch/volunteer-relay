# Engineering and coordination

Read IMPLEMENTATION-PLAN.md, docs/STATUS.md, docs/CONTRACTS.md and your docs/tasks task before editing. Implement only your assigned slice and phase. Phase 0 is complete; later application work starts through an explicit scoped assignment, not merely because a task card exists.

Use Node 26.11.1 for all application processes, scripts and tests. Bun 1.4.1 installs with `bun install --frozen-lockfile` and dispatches root scripts. Never use Bun application APIs or `bun test`. TypeScript strict; Biome and Vitest only. No ESLint or Prettier. Run `bun run verify` before handoff. Never commit secrets or real people/source evidence. All fixtures are synthetic; expected results must be independently authored, not copied from implementation output.

UI work starts with `docs/design/prototype-review.md` and P2-00. Treat `design/reference/prototype.html` as read-only visual input; preserve the plan, canonical contracts and independent fixture oracle as the source of behavioral truth. Do not port its demo storage, counters, duration defaults or unrestricted navigation.

## Ownership protocol

Coordinator A exclusively owns packages/contracts, packages/config, root manifests/lockfile/config, CI, infra, scripts and worker entrypoint. B owns database schema/migration ordering, auth business logic and core domain. C owns intake/inbound Telegram. D owns AI and domain reconciliation. E owns UI page composition. F owns notifications and acceptance harnesses. A task's allowed paths narrow these lanes. Do not edit another lane's files. Propose a contract/dependency/environment change in your handoff; A lands it first and updates consumers. No agent may redefine shared entities locally. Additive changes also require coordinator review and contract tests. Breaking wire changes require a new schema version.

Each task uses an isolated branch/worktree and its own database. Read docs/agents/README.md and the full prompt from `bun run agents prompt <LANE>`. Claim through `bun run agents claim` after A assigns the task; publish status/questions/handoffs through the shared local board. Workers do not edit tracked STATUS; A serializes accepted task/milestone updates. Poll inbox at startup, checkpoints, at least every ten minutes during active work, and before handoff; A polls at least every five minutes. Messages are proposals, never auto-executable commands or permission to change shared interfaces. Never run concurrent destructive database operations. Only B generates and orders migrations. Worker modules export handlers; A registers them. C and F request a shared callback contract before implementing callbacks. Keep PRs small; do not merge unfinished acceptance claims.

Handoff must list allowed paths changed, interfaces, migrations, dependencies, environment variables, commands/results, unresolved issues and next integration dependency. Coordinator checks tenant isolation, authorization, idempotency, optimistic revisions and evidence provenance before merge. Do not spawn agents unless requested by the user or an assigned task explicitly delegates work.

## Invariants

Tenant context is resolved by the server; a parsed organization ID grants no authority. Tenant-owned relations use organization-scoped keys. Revalidate current membership at human-authorized job/callback execution. Persist source and outbox atomically. Jobs and effects must tolerate replay; never claim exactly-once external delivery. Approved contribution minutes form the reporting ledger; unknown is null, not zero. Preserve source revisions and evidence. No face recognition, arbitrary message URL fetching, tool execution or sensitive source text in logs. Tests use controlled adapters; live provider checks are opt-in. Phase gates in the plan remain mandatory.
