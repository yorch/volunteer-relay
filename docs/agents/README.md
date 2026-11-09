# Native Crewplane operation for Volunteer Relay

Relay invokes the separately installed Crewplane CLI directly. It keeps only project policy, instructions and task cards; no Node launcher or local orchestration engine remains. crewplane.json policy version 2 supplies the exact requiredVersion and ordered promptFiles for A/B/C/D/E/F/R/V. Crewplane itself enforces the pin, resolves primary-checkout guidance and handles process signals. Product processes/scripts/tests remain Node26.11.1, with Bun1.4.1 for packages and normal script aliases.

## Install the required upstream release

```sh
version="v$(node -p "require('./crewplane.json').requiredVersion")"
curl -fsSL "https://raw.githubusercontent.com/yorch/crewplane/${version}/install.sh" -o /tmp/relay-crewplane-install.sh
CREWPLANE_VERSION="$version" sh /tmp/relay-crewplane-install.sh
export PATH="$HOME/.local/bin:$PATH"
crewplane --version
```

The installer selects the platform asset and verifies its published checksum. This project pins the published and verified [0.3.0 release](https://github.com/yorch/crewplane/releases/tag/v0.3.0), which supplies native policy v2 support. Old 0.2 clients reject policy version 2 rather than silently ignoring its pin or custom prompts. The optional test-only CREWPLANE_TEST_BIN selects a candidate executable for synthetic acceptance; it is not a runtime launcher setting. Release upgrades are explicit configuration/review changes. The standalone binary needs neither Node nor Bun; Git, harness credentials and browsers remain external.

requiredVersion is an exact pin, not a range. Mismatches fail before project store preparation. Pinned project commands do not schedule background self-update; global --help/--version/update remain available for recovery. An explicit global update can change the installed version independently, so use the installer with CREWPLANE_VERSION for an exact project release. Missing executables produce the shell's normal command-not-found error; no wrapper downloads tools or falls back to copied code.

## Project instructions, in any harness

```sh
crewplane agents prompt B
crewplane agents brief
crewplane agents inbox --agent B
```

Normal aliases (`bun run agents ...`, `bun run agents:dashboard`, `just agents ...`) call the same installed executable, with no project code in between. Policy and prompt files resolve from the canonical primary, including calls from worker checkouts. Built-in role boundaries are followed by each lane's ordered project files; R/V do not receive worker bootstrap context. No custom prompt command executes scripts. Crewplane rejects unsafe/missing/oversized files; per-file limit is 32 KiB and the total rendered prompt is at most 64 KiB.

At the start of a tool-capable supervised turn, follow AGENTS.md and run the same native `crewplane agents prompt <LANE>` to read Relay's full guidance. No-tools harnesses cannot use the board or implement changes; do not misrepresent their capabilities. Manual conversations in Codex/Claude/pi/OpenCode can use these project instructions without implying that a given installed release certifies their provider/version. Explicit runtime setup follows HEADLESS.md.

Workers follow BOOTSTRAP.md using the actual new assignment's exact base and isolated task resources. No historical first-wave card or old session grants authority. A owns shared changes, gates, review/integration and tracked STATUS updates; FOUR total model processes remain the limit. A ready submission freezes its tip until a current-assignment/exact-SHA correction request. Reviewer R and visual validator V are independent on-demand verification roles, not implementers or integration owners.

## Migration and stopped-state safeguards

The generic CLI intentionally does not encode Relay's old environment names or migration rules. Keep these project-specific safeguards:

1. Stop and inspect every prior controller, watcher, dashboard and harness/child before operational cutover. Preserve leases/resources; never delete them to force takeover.
2. Preserve .relay-coordination and custom legacy stores as evidence. Never rename/copy them into .crewplane-state, import their config/claims/session IDs, or point CREWPLANE_COORD_DIR at them. Clear stale RELAY_COORD_DIR/CREWPLANE_COORD_DIR in manual environments. Native supervised children inherit their actual bound store normally; there is no adapter to strip that environment.
3. After integration, initialize the fresh default namespace with `crewplane init`; inspect `crewplane doctor`, `crewplane status` and `crewplane agents board`. This source PR does not run these against the real project or enable execution. The adoption's original empty store is not evidence of product completion.
4. A reviews durable STATUS/phase gates and existing accepted work/resources before issuing new exact-base assignments/scopes. Old holds/claims/checkouts stay frozen until deliberately inspected; they are not authority for new sessions.
5. Activation still requires explicit operator direction and reviewed private runtime configuration. The committed example is disabled and contains deliberate executable/stopped-confirmation placeholders. Never copy old allowlists, change model identity or raise budgets silently.

Private .crewplane-state/.crewplane-local and the old .relay-coordination/.relay-local remain excluded from Git/Docker. Do not record secrets, private reasoning or source evidence in messages or tracked docs. Native tool storage remains local coordination, not an OS sandbox or hostile multiuser authorization boundary.

## Observation, review and controls

```sh
crewplane dashboard --port 4310
crewplane monitor --once
crewplane watchdog status
crewplane status
```

The dashboard is read-only. Native process liveness, reported task progress and verified acceptance are separate; missing model/usage data stays unknown. Runs expose normalized metadata, not raw stdout/private reasoning. Browser evidence capture remains external; use `crewplane evidence ...` for bounded ingestion. See upstream docs/USAGE.md for the current runtime protocol and limitations.

A publishes scopes and exact-base assignments, sends reviewers exact-SHA requests and routes required fixes back to the original author. Questions identify their task; replies stay on the original thread. Use `crewplane agents help` for exact status/checkpoint/accept arguments. Integration is explicit Git rebase/ff or squash, never a merge commit or automatic acceptance. Watchdog notices cannot start/retry controllers, clear holds or change budgets. `crewplane stop` and signals drain; wait for settled children/traces and released ownership before replacing the controller.

Rollback requires stopped inspected operation and a source revert, preserving all private namespaces. Do not run the old and new engines together. Core scheduling/harness/dashboard tests stay upstream; Relay retains only native configuration/worktree/prompt integration coverage and its product tests.
