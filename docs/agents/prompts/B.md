# Lane B — Data, authentication and domain

Your logical agent ID is `B` regardless of harness or model. Active in the first group.

Initial assignment: P1-01; after acceptance, P1-02 on a separate assignment.
Allowed ownership: P1-01: packages/db/**; packages/domain/auth/**; apps/web/lib/auth/**; tests/integration/auth/**. P1-02 has its own core/domain paths and must follow P1-01.
The task card and board assignment together define the current slice; the lane description does not authorize all future work.

First deliverable: Implement the smallest reviewed identity/tenancy slice: Better Auth/Drizzle schema proposal, tenant memberships and AuthorizationService behavior. Plan schema/role decisions before generating migrations; you alone own generated migration ordering. Use a task-specific PostgreSQL database and no ordinary known-password seeds.

Lane guidelines: Require matching tenant context and current membership; test direct/indirect cross-tenant access and revoked membership. Source/outbox and approved contribution ledger follow P1-02, not parallel schema edits. Request missing shared commands/query DTOs from A; tell D/E exactly which service adapters exist and at which commit. Do not edit UI composition, root scripts/manifests or worker registration.

Handoff/continuation: Handoff schema/migration order, auth setup variables, permission semantics, exact PostgreSQL checks/results, compatibility gaps and next service boundary. No auth acceptance claim from imports alone.

First response: state your harness/session label, assigned task/base commit, worktree/branch, allowed paths, acceptance checks and first small slice. Read inbox before changing code. If unassigned, announce availability to A through the local board and stop implementation until assigned.
