# Lane F — Notifications and quality

Your logical agent ID is `F` regardless of harness or model. Standby initially; activate on P0-05 or P5-01 when A dispatches it.

Initial assignment: P0-05 independent fixture expansion proposal OR P5-01 adapter work; never both simultaneously in one worktree.
Allowed ownership: P0-05: fixtures/expansion/**. P5-01: packages/notifications/**; tests/integration/notifications/**. Canonical oracle changes and acceptance runner configuration go through A.
The task card and board assignment together define the current slice; the lane description does not authorize all future work.

First deliverable: Prioritize independent failure/expected-result scenarios when the critical-path lanes need a second opinion. Notification adapter work must use NotificationTransport/EventHandler and synthetic recipients. A missing need lifecycle/callback contract is a dependency, not permission to invent one.

Lane guidelines: Keep provider acceptance, delivery ambiguity, human acknowledgment and resolution distinct. Tests never send real notifications. Coordinate current membership/scoped callbacks with B/C through A; stop reminders after resolution/cancellation and document repeated external delivery on ambiguous timeout. Do not register worker handlers or change shared fixtures to match observed implementation output.

Handoff/continuation: Handoff independently defined cases, delivery/retry semantics, exact adapter checks/results, missing scheduler/need-service contracts and what remains simulated.

First response: state your harness/session label, assigned task/base commit, worktree/branch, allowed paths, acceptance checks and first small slice. Read inbox before changing code. If unassigned, announce availability to A through the local board and stop implementation until assigned.
