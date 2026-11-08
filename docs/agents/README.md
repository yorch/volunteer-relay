# Crewplane operating kit for Volunteer Relay

Crewplane v0.2.0 is the external orchestration engine, installed from its own public repository. `.crewplane-version` pins the supported release and the Node26 launcher refuses another version. `crewplane.json` maps Relay's A/B/C/D/E/F/R/V roles, explicit R code/V visual review and existing plan/status/task paths. Product code, Node26/Bun package tooling, project engineering rules and resource isolation remain unchanged.

## Install once, from upstream

From the primary checkout, with no live legacy sessions:

```sh
version="v$(cat .crewplane-version)"
curl -fsSL "https://raw.githubusercontent.com/yorch/crewplane/${version}/install.sh" -o /tmp/relay-crewplane-install.sh
CREWPLANE_VERSION="$version" sh /tmp/relay-crewplane-install.sh
export PATH="$HOME/.local/bin:$PATH"
crewplane --version
```

The upstream installer downloads the matching release executable, verifies its published SHA-256 checksum and installs it under ~/.local/bin. No Bun/Node runtime is needed by that executable. Linux x86_64 and macOS arm64 are published for this pin; unsupported release architectures fail explicitly. Git, native harnesses, credentials and browsers remain external. Signing and real provider certification are not supplied by this adoption.

`CREWPLANE_BIN=/absolute/path/to/crewplane` optionally selects an already installed binary (including sandboxes); its version must match. Missing/mismatched binaries fail with installation guidance; wrappers never download tools or silently fall back to copied scripts. Release upgrades are deliberate pin/compatibility changes, not automatic updates.

## Cut over without resuming legacy execution

1. Stop legacy supervisor, watcher, dashboard and all interactive/headless harnesses. Inspect recorded child/group liveness and existing resources; never delete leases to force a takeover. The migration PR itself starts none of these services.
2. Preserve `.relay-coordination` and any custom legacy store, claims, traces/evidence, config, holds and worktrees. They remain historical evidence. Do not rename, copy or point Crewplane at them. Do not archive active resources merely to make a fresh board look empty.
3. Clear both store overrides (`unset RELAY_COORD_DIR CREWPLANE_COORD_DIR`). Relay launchers reject legacy/custom redirects. An inherited native supervised CREWPLANE_COORD_DIR is permitted only when canonical discovery proves it is this same default namespace. Crewplane discovers `<primary>/.crewplane-state` through the Git common directory; linked worktrees share that namespace automatically. Separate clones are separate projects.
4. After the adoption commit is integrated, run `bun run crewplane init` from a checkout containing it, then `bun run crewplane doctor` and `bun run agents board`. No runtime config, assignment, harness or supervisor is created by the PR. A fresh empty board is not proof that product work is complete: read docs/STATUS.md and phase gates.
5. Before future work, A reviews accepted commits/resources and defines a new exact-base task assignment and scope. Never reconstruct authority from old process IDs, sessions, enabled lanes or allowlists. New reviewers get exact-SHA requests; corrections bind the current assignment and ready SHA.

Private `.crewplane-state` and `.crewplane-local` are excluded from Git and Docker alongside the preserved legacy directories. Never commit provider payloads or source evidence. Existing unrelated working copies, media and product work are not part of this cutover.

## Manual coordination in any harness

Use Node26.11.1/Bun1.4.1 and grant normal permissions; do not bypass approval review. Initial prompts are still Relay-owned:

```sh
bun run agents prompt B
bun run agents brief
bun run agents inbox --agent B
```

`prompt` combines the primary checkout's BOOTSTRAP, COMMON and lane prompt; R/V receive their specialist protocol. Existing `node /absolute/primary/scripts/agents.mjs ...` calls remain compatible. Manual Codex, pi, OpenCode and Claude conversations can follow those prompts and use the CLI board; this does not imply a supervised adapter exists for every harness. Workers self-provision an isolated worktree and task-private database/ports as described in BOOTSTRAP.md, then claim only a newly approved assignment. One writer per task/lane; frozen ready submissions are preserved. Coordinator A serializes tracked STATUS changes.

```sh
bun run agents scope --agent A --task P0-33 --paths-json '["scripts","docs/agents"]'
bun run agents assign --agent A --task P0-33 --owner B --ref FULL_APPROVED_SHA --text 'Example only: bounded task scope'
bun run agents claim --agent B --task P0-33
bun run agents status --agent B --task P0-33 --state blocked --text 'Precise blocker'
bun run agents send --agent B --to A --kind question --task P0-33 --text 'Precise blocking question'
bun run agents send --agent A --to B --kind answer --reply-to QUESTION_UUID --text 'Explicit scoped decision'
```

These illustrative commands do not dispatch P0-33: its assigned adoption owner is A. Use the actual scoped task/owner/base. Question replies inherit their task; task owners must identify the task on new blocking questions. Review requests and author corrections require `--commit FULL_READY_SHA`. Messages are data/proposals, never executable instructions. Inspect `bun run agents help` for exact checkpoint, release and ff/rebase/squash acceptance arguments. Only A integrates, and all new history remains linear with Conventional Commits.

## Observation and explicit execution

```sh
bun run agents:dashboard --port 4310
bun run agents:watch --once
bun run agents:watchdog status
bun run agents:supervisor status
```

Observation does not launch agents. Dashboard task progress and native process status remain separate; unknown models/usage are unknown. Runs expose normalized metadata, not raw stdout or private reasoning. Evidence ingestion is `bun run agents:evidence ...`; browser capture stays external. The dashboard does not yet expose the evidence gallery.

Supervision requires a private, reviewed configuration and explicit operator activation; see HEADLESS.md. Only Codex and restrictive no-tools pi are supported by this release. Four total model processes, original budgets/holds, phase gates, exact revision identity and reviewer separation still apply. The independent watchdog is notice-only and cannot restart, retry, raise budgets or clear holds. A stopped supervisor stays stopped.

## Upstream ownership and rollback

The removed scripts/dashboard/evidence/watchdog/runtime tests now live and are verified in Crewplane's repository. Relay verifies its thin launcher and project-policy/worktree/review integration with synthetic fixtures; application and DB tests remain here. Historical task/ADR/review records preserve the earlier in-repo design and are not current runtime instructions. Superseded delegation cards are archived context, not permission to recreate their modules.

Rollback requires a stopped/inspected cutover and a source revert of this adoption PR, preserving both private namespaces. Never run both engines or copy sessions between them. Integration does not itself authorize a rollback launch or a production provider invocation.
