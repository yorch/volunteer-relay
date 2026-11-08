# Supervisor operating contract

The deterministic supervisor starts only explicitly assigned, allowlisted tasks. The coordinator scopes the next gate; it must not equate an empty dispatched queue with a completed plan. A remaining backlog generates one planning event per backlog/acceptance revision. A must dispatch independent accepted-baseline scopes, record a real dependency/decision, or explain a gate; it must not poll the board through repeated model turns.

## Scheduling and corrections

Use Node26.11.1 and the current primary CLI. The operator controls process/time/hourly budgets, harnesses, binaries and models. Validated atomic changes to allowed tasks/enabled lanes reload between passes; immutable changes report RESTART_REQUIRED and need a deliberate drain/restart. Old children keep their identity and resources.

`agents schedule --agent A --task P0-32 --priority gate-critical --dependencies-json '[{"taskId":"P0-24","require":"accepted","commit":null}]'` publishes explicit scheduling metadata. Enqueue age is immutable. Ready dependencies and new typed R/V review requests pin an exact SHA: `agents send --agent A --to R --kind request --task <ID> --commit <SHA> --text <brief>`. Text-only historical briefs retain legacy pin limitations.

One native process per lane; at most the configured total (never more than four). A keeps reserved capacity. Eligibility precedes priority/age/FIFO; dependency/phase/hold/budget constraints cannot be aged away. Runtime queue reasons describe actual selected/blocked/capacity states, not productive work or ETAs.

One executing task may coexist with frozen ready submissions. Every independent assignment uses its own worktree and services. A must publish known scopes for delegated modules; overlapping known scopes are serialized across lanes. For a required correction, A sends a new task-specific request. If another task is working, its session must safely `agents checkpoint --agent <LANE> --task <CURRENT> --text <handoff>` and finish its native turn. Only then can the original task session resume. Never change an active session's checkout. Ready completion prevents repeat execution of the same correction; authors should still answer the original board thread, and A alone accepts/integrates.

## Controls

- `pause --lane X`: hold future turns; active work drains normally.
- `nudge --lane X --text ...`: informational input only. It cannot clear a hold or failure.
- `resume --lane X`: remove operator hold/operator pause; preserve failures and indispensable decisions.
- `retry --lane X`: explicit recovery after inspecting the paused run. It does not override a remaining hold.
- `stop`: intentional global stop, desiredRunning=false, drain all native work and final persistence before releasing ownership.
- `rollout`: authorized drain with desiredRunning=true; it does not itself start a replacement. The operator/service owner waits for exit/lease release before starting one replacement with reviewed code/config.

A stopped supervisor stays stopped. Never change the intended stop merely because its old heartbeat ages. Never delete the lease or orphan checks to force a start.

## Health and data

The independent watchdog runs every180s with bounded cooldown, safe private state and signal coverage. It observes loaded queue/coordination/operation signals and writes fixed fault codes. Actionable faults queue an informational A nudge only when running is explicitly intended; no automatic acceptance, budget increase, failure retry or supervisor replacement. A dead controller still requires its service owner. Unknown/malformed/overflowed signals remain unavailable.

Result/trace persistence is part of a run, so shutdown keeps ownership until it settles. On startup verify old children before reconciling abandoned running traces. Preserve native task identities and private resources. Normalized traces exclude arbitrary tool output and private reasoning; model identifiers and event fields are bounded projections.

Use the dashboard's loaded-budget source, next-eligible time, queue reasons and open assignments. A historical ready summary is not a current task state. Submitted tasks await coordinator disposition, which may include author fixes, integration or further visual checks; code review alone is not acceptance.

P0-32 documents this isolated audit. Do not start a live supervisor simply to test changes: use fake adapters and temporary repositories. Activation after this branch is reviewed/merged remains explicit.
