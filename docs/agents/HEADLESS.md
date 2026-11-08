# Dedicated headless operation

This overrides first-wave launch defaults. One Node supervisor runs approved Codex CLI sessions with explicit native thread IDs; no --last, bypass flags or parallel writer for a lane. The operator confirmed previous B/E/D/R harnesses stopped before replacement. Preserve all existing worktrees, dirty work and private services. Do not launch another supervisor/harness or change its config, task allowlist or budgets from an agent.

## Ownership and scope

While the supervisor is running, its A session owns the primary integration checkout. The interactive A conversation is read-only for source/Git mutations; it may inspect status and queue operator notes. To reclaim writes, pause A with `bun run agents:supervisor pause --lane A`, wait until no A record is running, then explicitly take ownership. Resume only after interactive edits/checks/commits finish. Other lanes keep their own claimed checkout. Do not write another lane's source, reclaim its DB or remove its resources.

Only tasks listed in the private supervisor config are authorized (initially P1-06 and P1-07). A may make required shared contracts/config/integration changes and review/integrate those slices, but may not expand product phases or assign other task IDs without operator authorization/configuration. C/D/F stay on demand; idle is correct when no independent authorized work exists. Phase gates remain mandatory. Accepted migrations remain immutable. R is an independent reviewer, not an implementation owner.

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

`bun run agents:supervisor status` shows records/session IDs/usage and failures. `pause --lane X` prevents new turns but lets an active turn finish. `resume --lane X` resumes scheduling; `retry --lane X` clears a failure pause after inspection. `nudge --lane A --text 'operator instruction'` queues steering without concurrent source writes. `stop` drains all active turns before exiting; Ctrl+C/SIGTERM also drain. Do not raise budgets/task allowlists automatically.

Default limits: four concurrent lanes, 10-second event checks, 25-minute native runs, 20 runs per lane/hour, and pause after two turns without recorded progress. Timeouts/nonzero exits/invalid final output/operator-needed state pause the lane. One lease per supervisor/store prevents duplicate controllers; restart refuses a still-live recorded child PID. Inspect orphaned processes instead of silently stealing ownership. A task's state is never auto-changed just because a process exits.

Use saved CLI authentication and configured model defaults; optional per-lane model overrides are operator configuration, not chosen secretly by agents. Processes run workspace-write with automatic approval review, not sandbox bypass. Approval rejection, login/rate-limit/config failures are operational blocks to report, not reasons to disable safeguards. Private run logs/results/state are ignored and 0600; never print tokens, mail bodies, reset URLs or raw driver details into them. Per-run logs are capped at 20 MiB and retained to 20 runs per lane. Token counts are raw usage, not dollar pricing.
