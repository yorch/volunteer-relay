# ADR 0011 — Adopt the released external Crewplane CLI

Status: accepted for the P0-33 adoption PR; live execution remains stopped.

Volunteer Relay's orchestration engine was extracted and independently verified in yorch/crewplane. Maintaining copied schedulers, native harness handling, traces/evidence, watchdog and dashboard here would diverge from the fixed upstream implementation. The operator explicitly requested adoption in an isolated worktree with a PR.

Use the separately installed v0.2.0 release, pinned by .crewplane-version. A thin Node26 launcher checks the exact installed version, forwards argv and drain signals, and resolves Relay-owned full lane prompts from the canonical primary. crewplane.json holds existing A/B/C/D/E/F/R/V roles and plan/task/status paths. Existing bun/just command entrypoints remain; external CLI implementation/tests are removed from this repository. Product/DB/retention/provisioning/video code, interfaces and dependency lock are unchanged. The standalone CLI's bundled Bun is a tooling exception, not a change to Relay's Node26 runtime.

No legacy state migration occurs. Preserve .relay-coordination and all its resources as evidence. Use fresh .crewplane-state/.crewplane-local namespaces and reject legacy/custom store overrides through Relay's launcher during cutover, while accepting a verified native child binding to the canonical default store. No installed private config, enabled lane or allowlist is committed. An example is disabled and contains deliberate stopped-confirmation/executable placeholders. Live activation requires operator direction after stopped-process/resource inspection and fresh phase-gate-approved assignments. A blank new board is not product completion.

CI installs the pinned upstream release with checksum verification; Relay tests the adapter and real-binary linked-worktree/task/question/frozen review/integration behavior using synthetic repositories. Core engine/browser/native lifecycle tests remain upstream, avoiding duplicate runtime maintenance. Removed historical ADR/delegation/review evidence stays archived. Rollback is a stopped inspected source revert, never a store/session copy or parallel-engine launch.

## P0-34 follow-up — eliminate the temporary adapter

Crewplane policy v2 now owns requiredVersion enforcement and declarative promptFiles composition. Relay removes its Node adapter, compatibility entrypoint and .crewplane-version; package/just aliases invoke the installed binary directly. Both reusable behaviors are maintained once upstream. Policy v2 makes pre-feature binaries reject the configuration, while the pin suppresses project-command automatic upgrades. Signal handling is already native. Relay-specific legacy cutover warnings stay in project documentation; no generic tool code imports legacy paths or protocol. The follow-up must use a published release carrying these capabilities, not a locally mislabelled binary or fallback wrapper.
