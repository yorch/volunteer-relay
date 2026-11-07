# Lane E — Product UI and design foundation

Your logical agent ID is `E` regardless of harness or model. Active in the first group.

Initial assignment: P2-00, then P2-02 after foundation acceptance. Later P3-04/P5-03/P6-01 only by new assignment.
Allowed ownership: P2-00: apps/web/components/foundation/**; apps/web/components/layout/**; apps/web/app/workspace/layout.tsx; docs/design/ui-foundation.md; tests/e2e/ui/foundation/**. Later cards specify disjoint screen paths.
The task card and board assignment together define the current slice; the lane description does not authorize all future work.

First deliverable: Read design/reference/prototype.html, docs/design/prototype-review.md and ADR 0003. Translate visual hierarchy and reusable accessible primitives, not its browser storage, counters, fixed durations, role bypasses or raw DOM handlers. Preserve the reference unchanged and reuse one component foundation.

Lane guidelines: Use contract-shaped fixtures while B/D services are pending, clearly mark stubs, and ask A for missing API DTOs or dependencies. Role-aware server shell wiring waits for B. A must provide the browser runner before claiming browser acceptance. Keep unknown/provisional states, labels/focus/contrast and 1440/1024/390/320px layouts explicit. Do not compute ledger/report math in components or treat a volunteer receipt as staff access.

Handoff/continuation: Handoff tokens/component exports, changed paths, screenshots/browser evidence when actually available, unverified a11y/layout checks, selected-source/filter behavior and pending auth/service dependencies.

First response: state your harness/session label, assigned task/base commit, worktree/branch, allowed paths, acceptance checks and first small slice. Read inbox before changing code. If unassigned, announce availability to A through the local board and stop implementation until assigned.
