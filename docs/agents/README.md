# Local multi-agent operating kit

## Recommended starting size

Start with **four active sessions: A coordinator/integrator + B data/auth/domain + D extraction/evals + E UI foundation**. This is a repository-specific starting estimate, not a universal optimum. B's tenant/domain persistence is the critical path; D and E have useful contract/fixture-backed work. A needs capacity to settle contracts, review migrations and integrate continuously. Six logical lanes remain defined, but do not start all six by default.

| Wave                    | Active sessions                                                                                | Completion / rotation rule                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| First                   | A + B(P1-01) + D(P2-01) + E(P2-00)                                                             | Land small independent slices; no later screen/integration scope implied.                  |
| M2 integration          | A + B(P1-02) + D(extraction wiring assigned separately) + E(P2-02)                             | Close the first reviewed web workflow and required live-provider smoke before claiming M2. |
| Intake / follow-through | Keep A; rotate C(P3-01) and F(P0-05 or P5-01) in when a lane completes or is genuinely waiting | Pure adapter/fixture tasks may start earlier if a worker slot is available.                |

Increase to five or six only when there are scoped, disjoint, unblocked tasks and A can review at their delivery rate. Observe completed accepted slices, rework, merge conflicts, review queue and idle/block time after the first two slices. Reduce concurrency if review queues grow or agents invent work while blocked. One session per logical lane; switching harnesses does not add capacity or change ownership.

## What is shared

`bun run agents ...` is a dependency-free Node 26 CLI. It reads task cards and writes JSON files to `<primary-checkout>/.relay-coordination/`, discovered from Git's common directory so linked worktrees use the same store. This directory is ignored by Git and Docker build contexts and is **not** inside .git. Put an overridden store outside the repository, or explicitly exclude that custom path from Git and build contexts too. No database, network service, external messages, harness API, daemon or automatic command execution is involved. All commands emit JSON except help and prompt output.

Assignments validate the task card at the exact baseline commit and permit one active assignment per lane. Assignments, exclusive claims and messages publish complete files with atomic no-overwrite links; progress snapshots replace a file atomically. Separate message files avoid concurrent JSONL appends. Live state is advisory process coordination, not authentication or a secure sandbox: `--agent A` is a convention, not identity proof. Only run trusted local sessions. The task card limits paths; the tool does not prevent arbitrary filesystem/git/DB changes. A reviews diffs and checks path ownership before merging.

Tracked docs contain durable decisions, scope and accepted milestone status. Live assignment/claim/progress/questions stay in the ignored store; workers never race to edit docs/STATUS.md. A carries accepted decisions into contracts/ADRs/task cards and reconciles STATUS. `ready` is not `accepted`, and `accepted` is a coordinator attestation plus an ancestry check, not automatic proof that tests ran.

## Prepare sessions in any harness

1. Activate Node 26.11.1 with your runtime manager (for example `fnm use`) and confirm `node --version` / `bun --version` report 26.11.1 / 1.4.1. Review AGENTS.md. Run `bun run agents init`; it prints the shared path. Set `RELAY_COORD_DIR` to the **same absolute path** in every session if a harness sandbox cannot use the default. Grant the required read/write access explicitly; do not bypass a harness permission rejection. The store checks its Git common directory; separate clones are not supported as one live board. Use linked worktrees of this repository.
2. From the coordinator checkout, choose an integration commit containing this kit. Example once the first wave is dispatched:

```sh
bun run agents assign --agent A --task P1-01 --owner B --ref HEAD --text 'Wave 1: identity/tenancy slice in P1-01 only'
bun run agents assign --agent A --task P2-01 --owner D --ref HEAD --text 'Wave 1: deterministic extraction/eval slice only'
bun run agents assign --agent A --task P2-00 --owner E --ref HEAD --text 'Wave 1: visual foundation only'
```

Workers create/resume their own linked worktree from the assignment's exact baseCommit using docs/agents/BOOTSTRAP.md. Setup may start before assignment using primary HEAD, but application work waits for dispatch/baseline verification. B provisions its own Compose PostgreSQL project on port 55431, development database relay_b_p1_01 and separate relay_b_p1_01_test; D needs no database/provider for its first slice; E previews on port 3103. Each worker creates ignored local environment/attachment/setup files. Do not start the same Compose project/ports or reset a shared database.

3. Open each chosen harness in the primary checkout or its already-created worker worktree; its prompt tells it to create/resume its own worktree. To obtain the **full copy/paste initial prompt**, run `bun run agents prompt B` (or A–F) and give that output to the session. This concatenates BOOTSTRAP.md, COMMON.md and the lane prompt. Do not assume a particular harness's implicit instruction loader. No harness-specific command flags or cross-harness agent APIs are required. C/F prompts are ready but remain standby until assigned. The kit does not itself start any harness, worktree or application worker.
4. Workers install with `bun install --frozen-lockfile`, read board/inbox/card, and claim from their linked worktree:

```sh
bun run agents claim --agent B --task P1-01
bun run agents status --agent B --task P1-01 --state working --text 'Schema proposal in progress; next: tenant FK review'
bun run agents inbox --agent B
```

The claim rejects another lane, a duplicate claim, the primary checkout for workers, or a branch lacking the assigned baseline. A worker resuming the same claim/worktree must inspect it and continue rather than claim again.

## Questions, answers and handoffs

```sh
bun run agents send --agent D --to B --kind question --task P2-01 --text 'Which membership lookup will CandidateRepository use? Please cite the proposed contract/commit.'
bun run agents inbox --agent B --unanswered true
bun run agents send --agent B --to D --kind answer --reply-to <question-UUID> --task P2-01 --text 'Proposal only: use the server-resolved membership lookup. A must land the interface before consumers wire it.'
bun run agents send --agent E --to A --kind request --task P2-00 --text 'Need the browser runner before claiming viewport/a11y acceptance.'
bun run agents board
```

`--to all` broadcasts. Replies target the original sender; an answer references a question/request UUID. A reply is a proposal until the designated owner/A lands any shared decision. Questions remain inspectable even when answered. Inbox has no read receipts/cursor and does not wake an idle harness. A/the operator must resume an ended or idle session after dispatch or a blocking answer; writing a file alone never triggers another model turn. A polls at least every five minutes; workers at startup, each slice/check/commit, at least every ten minutes while active, and before handoff. Progress every meaningful milestone / roughly fifteen minutes, not a stream of token-by-token chatter. A blocked lane posts a precise question and its own blocked status; use polling at normal tool boundaries rather than long blocking sleep loops.

For multiline handoffs write a local ignored/temp text file and use `--file /absolute/path/handoff.md` instead of `--text`. Include: scope, changed paths, interface/dependency/env changes, migrations, actual checks/results, exact commit, risks and next dependency. Keep secrets, credentials and raw private reports out of notes.

```sh
bun run agents status --agent B --task P1-01 --state ready --commit HEAD --file /tmp/B-handoff.md
```

Ready requires the current committed HEAD and a clean claimed worktree. After ready, freeze that slice. A reviews, selects rebase plus fast-forward or squash according to AGENTS.md, runs the real relevant checks, then records acceptance from a clean integration checkout. Never create a merge commit. Default acceptance checks handoff ancestry and rejects merge commits in the integration range:

```sh
bun run agents accept --agent A --task P1-01 --commit HEAD --file /tmp/A-integration-checks.md
```

For rewritten commits, save main's exact tip before integration and pass `--strategy squash` or `--strategy rebase` with `--integration-base <saved-SHA>` to accept. The tool records the source SHA, resulting SHA, strategy and integration base, and compares aggregate binary diffs against the source branch's common ancestor with that base. Squash requires one resulting commit. The comparison is deliberately strict: if concurrent edits change patch context or conflict resolution changes behavior, request a refreshed worker handoff rather than bypassing the check. Use `--integration-base` for fast-forward acceptance too when recording the precise integration range. These checks establish change mapping, not correctness; A still reviews and tests.

The tool never merges, pushes, invokes a provider, modifies application contracts, or runs commands from a message. A must update tracked task/milestone status separately. If A requests changes before acceptance, the worker posts working status, commits revisions and produces a new ready handoff.

## Recovery and limits

No automatic claim expiry or heartbeat-based stealing: a slow harness may still be editing. Resume a stopped session in the same lane/worktree using board/inbox/git history. To reassign abandoned work, A first stops/verifies the old session is no longer writing, preserves/reviews any commits, then runs `agents release --agent A --task <ID> --text 'old session stopped; reason'`. This archives its entire task directory before a new assign/claim; it never discards branch commits or message history. Accepted tasks cannot be released; create a new scoped task instead. Old sessions must not resume after release.

Local disk only (not NFS/cloud-sync), one machine, one writer per claimed worktree/lane, one coordinator. Renames/links protect publication and duplicate claims; this is not a distributed transaction log, durable disaster-recovery system, identity boundary or unattended orchestrator. A crash between a status message and snapshot may leave them inconsistent; inspect both and repost status from the owning worktree. Stale temporary files can be ignored; never delete a current task to unblock yourself. Git-sync commits before changing machines; the ignored board does not travel with a clone. Copy durable decisions to tracked docs before retiring a run.

Design references: [Git linked worktrees](https://git-scm.com/docs/git-worktree) share repository metadata while isolating working directories; [Node filesystem APIs](https://nodejs.org/api/fs.html) provide file publication primitives used by the CLI. The recommendation of four active sessions is based on this repository's dependency graph.

## Prepared worker launch prompts

For the current three-worker setup, copy the entire contents of `docs/agents/launch/B.md`, `D.md` or `E.md` into the corresponding harness session. These snapshots include the shared and lane-specific instructions plus concrete local startup paths and commands. They work unchanged across shell-capable harnesses; choose any harness for any lane. A remains the existing coordinator session. Workers prepare their own branch/worktree, tools, dependencies, ignored local settings and task-private resources; only A dispatches assignments. They may complete setup before dispatch and wait only to start application code. Exact board baseCommit/current tracked rules take precedence.

## Live local dashboard

Run `bun run agents:dashboard` under Node 26.11.1 and open **http://127.0.0.1:4310**. Set `RELAY_DASHBOARD_PORT` to an unused port if necessary. The server binds only to loopback; use the printed 127.0.0.1 URL. Stop it with Ctrl+C. It uses no extra dependencies and is separate from the product web application.

The HTML page automatically refreshes every five seconds. It shows all task cards, unscoped illustrative roadmap items from IMPLEMENTATION-PLAN.md, live assignments/claims/status/acceptance, all board messages with reply context, unanswered questions/requests and the full milestone notes. Filter by agent, phase, state or text. Refresh does not reload the page or close expanded details. When disconnected, it retains the last snapshot and clearly reports it as stale.

Task cards and milestone notes come from the primary checkout even when launched in a linked worker worktree; the live board uses its existing shared Git-common-directory discovery or RELAY_COORD_DIR override. Accepted board records take precedence over worker status. A task's completed/accepted column may represent a bounded slice; milestone gates and remaining limitations still apply. Unscoped roadmap items have no invented owner and cannot be treated as assignments. Recorded progress does not establish that a harness is currently running.

The dashboard has no write controls or arbitrary file-serving route. Continue posting updates/questions/answers with the existing CLI; they appear automatically. Only card/STATUS edits and explicit board reports are shown—private harness conversations are not collected. Messages render as plain text. Local coordination notes remain on this machine and must not contain secrets. First access uses the existing board initialization if the store is absent; the dashboard never changes task status, executes messages or launches agents.

## Second-wave continuation

After the first-wave acceptance, A dispatches B/P1-02 (source/outbox persistence only) and E/P2-02 (development-only fixture intake/review screens) from an exact new baseline. Resume their existing conversations by pointing them to `docs/agents/resume/B-P1-02.md` and `docs/agents/resume/E-P2-02.md` in the primary checkout. These files supersede first-wave task/resource defaults and include new branch/worktree/private database instructions. Accepted first-wave worktrees remain frozen. D remains on standby pending a bounded persistence/worker assignment; no extra session is launched by board dispatch.
