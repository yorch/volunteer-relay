# Task ownership and parallel starts

**Current product status:** M2–M7 implementation and evidence are summarized in [PRODUCT-IMPLEMENTATION.md](PRODUCT-IMPLEMENTATION.md) and [STATUS.md](../STATUS.md). The dispatch and phase descriptions below are historical planning context; their statements that product work is queued or fixture-only have been superseded.

**UI revamp complete:** [P2-06](P2-06.md) is implemented and independently reviewed, with 264 browser cases at four sizes and a production-image visual follow-up. See the [comparison](../design/product-parity.md) and [current screenshots](../design/revamp-gallery.md). Live-service and deployment acceptance remain separate.

Current demo-data work: [P7-06](P7-06.md) is implemented with eight seed-safety cases plus two scoped workspace-metadata cases; see the [populated demo walkthrough](../demo.md).

## Current product task status

| Product task cards                | Current implementation and verification                                                                                                                                            | Open external or acceptance work                                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-00–P1-13                       | Auth, tenancy, source/outbox, ledger, needs and attachments are integrated. Controlled PostgreSQL and browser tests are recorded in [product evidence](PRODUCT-IMPLEMENTATION.md). | Live SMTP delivery and deployment operation remain open.                                                                                                               |
| P2-00, P2-01, P2-02, P2-04, P2-05 | Product intake/review UI and durable extraction/retry/reprocessing are integrated.                                                                                                 | Opt-in live model smoke and real model quality remain open; review the [prototype parity assessment](../design/product-parity.md) for visual and workflow differences. |
| P3-01, P3-04                      | Imports, private photos and Telegram adapter paths are integrated with controlled tests.                                                                                           | Actual Telegram and photo/model provider behavior remain unverified.                                                                                                   |
| P5-01, P5-03                      | Need lifecycle, routing, notification and delivery controls are integrated with controlled tests.                                                                                  | Real SMTP/Telegram delivery and human acknowledgment checks remain open.                                                                                               |
| P6-01                             | Ledger, filtered aggregates and CSV are integrated and tested against the independent synthetic oracle.                                                                            | Target-deployment/live-data validation remains open.                                                                                                                   |
| P7-03, P7-05                      | Production profile, recovery/retention and operator provisioning are integrated with isolated local rehearsals.                                                                    | Fresh-host, public TLS, provider, cutover and load gates remain open.                                                                                                  |
| P2-07                             | Extraction failures are scoped only: one synthetic row failed `VALIDATION` twice while a direct probe of the same text succeeded, so the cause is unestablished.                   | Not started; step one is capturing the reason codes under a stated attempt bound, not writing a date rule.                                                             |
| P7-07                             | Edge hardening (HSTS, security headers, body-size and rate limits) is scoped only; the operator chose to deploy with the current parity posture first.                             | Not started; must be decided before the host serves public traffic indefinitely.                                                                                       |

Current integrated verification passed 499 unit tests, 254 product integration cases and 264 browser cases across four viewports; exact snapshots are recorded in the linked evidence. These are controlled checks; see [product evidence](PRODUCT-IMPLEMENTATION.md) for exact scope and limitations. The coordinator archived the superseded local P2-05 and P3-01 entries on 2026-11-08 at 14:08 UTC; their original claim, handoff state and messages remain in archive history. The board then reported no active tasks or unanswered questions. These tracked records are the current product status, not a claim of additional board acceptance.

## Historical dispatch and phase plan

The following dispatch tables and phase sequencing describe the original planning state, not current task status. Product task cards now begin with their current implementation status and link to the consolidated evidence.

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

## External coordination adoption

[P0-33](P0-33.md) adopts the separately released Crewplane CLI through a pinned project adapter. It replaces duplicated tooling only; product phase gates and explicit live activation remain separate. Historical orchestration cards retain their original evidence, not current implementation ownership.

[P0-34](P0-34.md) removes the temporary adapter introduced in P0-33 after upstream native policy v2 ships. Required versions and full prompts are declarative project configuration; legacy cutover warnings remain documentation.
