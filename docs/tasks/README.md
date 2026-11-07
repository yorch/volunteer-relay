# Task ownership and parallel starts

Phase 0 task cards P0-01–03 are complete. The current prototype review/reference commit adds planning handoffs only. Later cards remain queued; no later application implementation is included.

After M0 contract review, the following can begin independently in separate worktrees:

| Task  | Lane | Allowed implementation paths                                                                                                                                  | Depends on                                               |
| ----- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| P1-01 | B    | packages/db/**, packages/domain/auth/**, apps/web/lib/auth/**, tests/integration/auth/**                                                                      | M0; canonical authorization port                         |
| P3-01 | C    | packages/intake/**, tests/integration/intake/**                                                                                                               | M0; SourceEnvelope; persistence wiring later             |
| P2-01 | D    | packages/ai/**, tests/integration/ai/**                                                                                                                       | M0; proposal and extraction ports; worker wiring later   |
| P2-00 | E    | apps/web/components/foundation/**, apps/web/components/layout/**, apps/web/app/workspace/layout.tsx, docs/design/ui-foundation.md, tests/e2e/ui/foundation/** | M0; reference review; dependency/role wiring through A/B |
| P5-01 | F    | packages/notifications/**, tests/integration/notifications/**                                                                                                 | M0; transport/event ports; routing wiring later          |
| P0-04 | A    | infra/**, .github/**, scripts/**, docs/runbooks/**                                                                                                            | M0                                                       |
| P0-05 | F    | fixtures/expansion/**                                                                                                                                         | M0; independent oracle review                            |

P1-02 follows P1-01 and stays in B's lane because both own database files. One owner may not execute overlapping cards concurrently. Fixture expansion and notification work may run separately only if separate owners are assigned. Worker registration, API route wiring and shared interface extensions are coordinator integration tasks. C/F Telegram callbacks require a frozen callback contract first. Cards intentionally restrict route edits to avoid UI/auth/ingress conflicts. Task-specific missing interfaces are an explicit dependency, never permission to invent a competing shared type.

## Prototype translation sequence

The user-supplied reference is frozen at design/reference/prototype.html; read docs/design/prototype-review.md before UI work. E starts P2-00 independently on the narrow paths in that card, then P2-02 consumes its foundation for M2 inbox/volunteer review. P3-04 owns import/photo screens (M3), P5-03 owns need-board screens (basic M2, delivery/deadlines M5), and P6-01 owns ledger/report screens (basic M2 ledger, full M6 reporting). These E cards are sequential by default; any split needs A-assigned owners and non-overlapping paths. They do not expand the current implementation scope.

B supplies domain services/query definitions, C intake, D extraction and F delivery. A lands missing query/lifecycle/upload/edit contracts and routes before E wires them. No lane implements reporting math or auth in UI to compensate for a missing service. P2-02 remains fixture-backed until its named prerequisites land; later screens cannot skip milestone gates because a reference button already exists.

## Dispatch and communication

See docs/agents/README.md and P0-06 for the harness-neutral operating kit. A starts with B(P1-01), D(P2-01) and E(P2-00); C/F are standby/rotation lanes. Local board assignments record exact baseline commits and task slices. Workers claim in isolated worktrees and post progress/questions/handoffs there; A alone updates tracked milestone/task status after acceptance. A task card existing is not an automatic assignment.
