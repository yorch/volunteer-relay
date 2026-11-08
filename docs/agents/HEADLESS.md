# Dedicated headless operation

This overrides first-wave launch defaults. One Node supervisor runs approved harness CLI sessions (Codex default; restricted Pi support per HARNESSES.md) with explicit native thread IDs; no --last, bypass flags or parallel writer for a lane. The operator confirmed previous B/E/D/R harnesses stopped before replacement. Preserve all existing worktrees, dirty work and private services. Do not launch another supervisor/harness or change its config, task allowlist or budgets from an agent except the standing operator directive permits A to prepare plan/gate task allowlist changes and approved role support; runtime budgets remain unchanged and reload uses an operator-channel draining restart.

## Ownership and scope

While the supervisor is running, its A session owns the primary integration checkout. The interactive A conversation is read-only for source/Git mutations; it may inspect status and queue operator notes. To reclaim writes, pause A with `bun run agents:supervisor pause --lane A`, wait until no A record is running, then explicitly take ownership. Resume only after interactive edits/checks/commits finish. Other lanes keep their own claimed checkout. Do not write another lane's source, reclaim its DB or remove its resources.

The approved IMPLEMENTATION-PLAN is standing authorization to advance necessary reversible work through mandatory gates. A must proactively scope/freeze/assign next tasks after acceptance, not stop at a completed batch. The private supervisor allowlist remains an operational scheduling bound: append concrete gate-eligible tasks, preserve budgets, and arrange an operator-channel draining restart for startup-only config. Do not leave assigned workers silently unschedulable. Keep next work and actual blockers in STATUS. C/D/F/V are on demand; idle requires dependencies, gate/resource limits or no useful parallel work. Accepted migrations/resources stay immutable. R and V verify; A integrates. Unresolved material product decisions, destructive/external actions without authority and real operational blocks go to the operator; routine continuation does not.

## Fast operating loop

Use the primary's CURRENT CLI, even from an older worker checkout:

- `node <primary>/scripts/agents.mjs brief` for compact task state, pending questions and recent message IDs. Do not print the full historical board into model context.
- `... inbox --agent <LANE> --unanswered true` for actionable incoming requests; use `--task <ID>` to read only relevant context when needed.
- Read current primary AGENTS/CONTRACTS/STATUS and your task/brief; consume approved shared commits before importing new interfaces. Preserve dirty owned work: inspect, commit a focused milestone if appropriate, then rebase your OWN clean branch; never reset or create merge commits. A's latest approved shared baseline is the supervisor launch baseline; later shared updates are announced by exact SHA.
- If a task already has your valid claim, resume it; do not claim twice. New unclaimed workers receive a pre-created isolated worktree from the exact assignment base; provision their OWN ignored environment/services following BOOTSTRAP and task resource instructions, then claim from there. B/P1-06 reuses its existing claim/worktree/private DBs; E/P1-07 needs no DB, and uses private browser port 3153.
- Run the baseline once per new environment. Do targeted checks at milestones and the full required gate before handoff. Do not repeat the full build/database/bootstrap for unrelated documentation changes or on every resumed turn.
- Publish meaningful progress, blockers, questions and exact ready handoffs. A submitted task stays frozen until a targeted revision request. Continue useful independent work inside the assignment while a nonblocking question is pending; do not request confirmation for routine implementation choices already authorized.

The supervisor handles wake-ups for assignments, direct questions/answers/requests, ready commits and failed lanes. It coalesces events while a lane is busy and resumes the same explicit native session for its task. Do not run a polling loop in the model: finish the turn when waiting. A fresh R request gets a fresh context; no arbitrary branch-following. If an indispensable operator decision is missing, report the exact issue and finish with needs_operator. The supervisor pauses that lane until an operator nudge/retry.

## A coordinator priority

1. Answer blocking questions/shared-port requests first; land the smallest tested canonical interface, then announce its exact commit. Do not work on coordinator tooling/refactors while implementation is blocked on A.
2. On a ready tip, immediately send R a pinned review request and run A's own independent checks in parallel using separate checkouts/DBs. A review brief may live in ignored `.relay-coordination/reviews/` and reference tracked task/ADR policy: do not create a tracked commit and rebase everyone merely to publish each review iteration. Record final dispositions/acceptance durably.
3. Batch confirmed required corrections into one focused revision request. Distinguish real blocking defects from optional style/hardening observations; do not create another review cycle for a nonblocking preference. R rechecks the exact updated tip, never a moving branch.
4. Integrate only after review plus actual checks, keeping linear Conventional Commits and existing source/result acceptance mapping. Scope meaningful retained commits through own integration rebase or noisy branches through squash. No automatic acceptance/merge by the supervisor.
5. Keep complementary E work active against frozen contracts while B owns server/migration logic. Prepare later scopes without authorizing unapproved phases. Assign only configured task IDs, one active implementation task per lane. Do not invent busywork for standby lanes.

## R priority

Read `docs/agents/prompts/R.md` and the exact incoming A request. Parent owns any DB checks. Review directly without child agents: the supervised child budget is zero so the four-process limit includes every model process. Each new review request already gets a fresh context. No unmanaged delegation or separate coordinator. Answer the original request with ranked reproducible findings or no actionable findings, checks/limits and exact SHAs. Do not send long progress dumps or claim acceptance. When done, wait for the next request; the supervisor selects a fresh session key.

## Controls and budgets

`bun run agents:supervisor status` shows records/session IDs/usage and failures. `pause --lane X` prevents new turns but lets an active turn finish. `resume --lane X` resumes scheduling; `retry --lane X` clears a failure pause after inspection. `nudge --lane A --text 'operator instruction'` queues steering without concurrent source writes. `stop` drains all active turns before exiting; Ctrl+C/SIGTERM also drain. Do not raise runtime budgets. A may prepare concrete plan/gate allowlist changes under the standing directive; reload remains an explicit safe operator-channel operation.

Default limits: four concurrent lanes, 10-second event checks, 25-minute native runs, 20 runs per lane/hour, and pause after two turns without recorded progress. Timeouts/nonzero exits/invalid final output/operator-needed state pause the lane. One lease per supervisor/store prevents duplicate controllers; restart refuses a still-live recorded child PID. Inspect orphaned processes instead of silently stealing ownership. A task's state is never auto-changed just because a process exits.

Use saved CLI authentication and configured model defaults; optional per-lane model overrides are operator configuration, not chosen secretly by agents. Processes run workspace-write with automatic approval review, not sandbox bypass. Approval rejection, login/rate-limit/config failures are operational blocks to report, not reasons to disable safeguards. Private run logs/results/state are ignored and 0600; never print tokens, mail bodies, reset URLs or raw driver details into them. Per-run logs are capped at 20 MiB and retained to 20 runs per lane. Token counts are raw usage, not dollar pricing.

## Authorized M1 continuation after P1-06/P1-07

The operator explicitly authorized P1-08 (A HTTP adapters), P1-09 (B verified-email lifecycle) and P1-10 (E production page composition) under ADR 0007. These concrete IDs are in private allowedTasks. Subsequent necessary gate-eligible plan tasks follow the standing directive and exact assignment protocol, preserving runtime budgets. The current supervisor reads configuration at startup: queued assignments require an operator-channel draining restart, not an agent-launched second supervisor. Existing accepted claims/checkouts and resources remain frozen. R reviews new exact tips; no new child delegation. Later work must satisfy its preceding mandatory phase gates; no full M1 completion is implied by this wave. Current task cards override initial P1-06/P1-07 resource defaults for these new assignments.

## V browser verification protocol

V is enabled on demand by an exact pinned A request, never implementation ownership. Read docs/agents/prompts/V.md and a brief using docs/agents/qa/TEMPLATE.md. V uses a new isolated pinned checkout/port, optional private DB, synthetic actions, Playwright/Chrome and actual screenshot inspection at desktop/tablet/mobile widths. Report ranked reproducible findings, expected/observed, artifacts, SHAs and limits to A's request. Authors fix; A accepts with behavioral evidence, never screenshots alone. R code review remains separate. No children, unmanaged models or duplicate V sessions; R/V/authors/A share FOUR total slots. Fresh native contexts per request; no request means no V model run. Pilot accepted /dev/auth at exact 2e2d4c0; dashboard is baseline assessment until a redesign is separately authorized.

## Harness identity

Read HARNESSES.md before changing any lane harness. Codex/default legacy sessions remain unchanged. Per-lane harness selection, explicit harness-specific model fields and per-harness binary paths are validated. No active lane switches to Pi by default. Installed Pi lacks a native permission sandbox; initial Pi support is tool-free only, not an implementation-workload substitute. Switching requires an idle/drained lane and fresh explicit sessionEpoch, preserving prior native records; never resume IDs across harnesses. Configuration remains startup-only and budgets/four-slot cap are unchanged.

## Short control turns and delegated implementation

A-control reserves one of four slots and targets2–3min turns/<=60s steering acknowledgment when practical, measured rather than promised. Native stdin steering waits until next turn. Blocking answers and ready review dispositions precede dispatch; do not synchronously implement/test every tooling request in A. Committed per-task exceptions may delegate disjoint scripts/dashboard modules under frozen interfaces; A retains shared approval/composition/integration. F/P0-20 owns evidence store/capture, D/P0-21 renderer only, C/P0-24 pure reload policy only. Active child harness/model/budget identity remains immutable. R/V get review slots; capacity-limited queues are truthful, not idle-work claims. P0-26 tracks durable receipt/turn/oldest-unhandled telemetry; heartbeat is not responsiveness. Config/model profiles are proposals until explicitly applied at safe fresh-session boundaries. No unmanaged implementation session, child or fifth slot.
