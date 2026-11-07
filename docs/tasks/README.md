# Task ownership and parallel starts

Phase 0 task cards P0-01–03 are the active scope. Later cards are scoped for handoff only. No later implementation is included in this baseline.

After M0 contract review, the following can begin independently in separate worktrees:

| Task  | Lane | Allowed implementation paths                                                             | Depends on                                             |
| ----- | ---- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| P1-01 | B    | packages/db/**, packages/domain/auth/**, apps/web/lib/auth/**, tests/integration/auth/** | M0; canonical authorization port                       |
| P3-01 | C    | packages/intake/**, tests/integration/intake/**                                          | M0; SourceEnvelope; persistence wiring later           |
| P2-01 | D    | packages/ai/**, tests/integration/ai/**                                                  | M0; proposal and extraction ports; worker wiring later |
| P2-02 | E    | apps/web/components/**, apps/web/app/workspace/**, tests/e2e/ui/**                       | M0; fixture-backed components; auth/data wiring later  |
| P5-01 | F    | packages/notifications/**, tests/integration/notifications/**                            | M0; transport/event ports; routing wiring later        |
| P0-04 | A    | infra/**, .github/**, scripts/**, docs/runbooks/**                                       | M0                                                     |
| P0-05 | F    | fixtures/expansion/**                                                                    | M0; independent oracle review                          |

P1-02 follows P1-01 and stays in B's lane because both own database files. One owner may not execute overlapping cards concurrently. Fixture expansion and notification work may run separately only if separate owners are assigned. Worker registration, API route wiring and shared interface extensions are coordinator integration tasks. C/F Telegram callbacks require a frozen callback contract first. Cards intentionally restrict route edits to avoid UI/auth/ingress conflicts. Task-specific missing interfaces are an explicit dependency, never permission to invent a competing shared type.
