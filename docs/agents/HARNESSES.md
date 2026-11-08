# Harness boundaries after Crewplane adoption

Manual conversations in Codex, Claude, pi or OpenCode may follow `bun run agents prompt <LANE>` and use the same CLI board. Every conversation still needs a newly approved task/base, isolated resources and normal harness permissions. A file message alone does not wake an arbitrary manual harness; check inbox at project-defined milestones.

Supervised execution is supplied by the pinned external Crewplane release, not local harness-session guessing. v0.2.0 supports Codex's native exec/schema/resume protocol and a restrictive pi no-tools adapter. Pi cannot implement filesystem changes under that policy. Claude/OpenCode native adapters and live provider/version acceptance are not delivered by this adoption. No session/model/approval bypass or child process is added here.

Read HEADLESS.md before any explicit activation. Preserve FOUR total processes, coordinator/reviewer capacity, operator stops, holds, exact session/assignment/revision identities and project phase gates. Never silently substitute a model, resume latest conversation, run an interactive worker alongside its supervised replacement or start a second controller. Credentials belong to the installed harness; Crewplane does not log in or serve as an OS sandbox. Doctor is prerequisite inspection, not provider certification.
