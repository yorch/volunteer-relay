# Feature audit for the hackathon video

> Current status, resume commands and drift policy: [`state.md`](state.md). Decisions: [`decisions.md`](decisions.md).

Audited from source at `00dfa71` (`main`) plus a read-only probe of the deployed
origin. Every claim names the code, route or test that supports it. Nothing here
is inferred from the implementation plan.

## Deployed release

| Check                                          | Result                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://volunteer-relay.brnby.com/api/health` | `200 {"status":"ok","service":"web","runtime":"26.11.1"}` on 2026-11-08                                                                                                                   |
| `https://volunteer-relay.brnby.com/api/ready`  | `200 {"status":"ready","runtime":"26.11.1"}`                                                                                                                                              |
| `https://volunteer-relay.brnby.com/sign-in`    | `200`, Next.js app shell renders                                                                                                                                                          |
| Deployment identifier / commit                 | **Unknown.** The deployment exposes neither a build id nor a commit header, and no hosted account is available in this environment. Do not attribute hosted footage to a specific commit. |

Hosted capture is therefore **blocked**: no recording-account credentials were
supplied and no authorized operator session exists here. All footage produced in
this workspace is labelled `local` capture from a disposable rehearsal database.
Hosted and local footage must never be mixed in one delivery.

## Scene-by-scene status

| Scene                             | Status                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 opening chat animation        | **Designed graphic.** Illustrative reenactment, not a chat provider recording. The on-screen "illustrative" label was removed at the operator's request (D8); treat the scene as a design asset, never as product evidence.                                                                                                      | `video/src/scenes/Opening.tsx`, `scenes.json` `onScreenDisclosure`                                                                                                   |
| S02 coordinator inbox             | **Working (local capture).** Queue lists pending extraction runs with source id, revision and text.                                                                                                                                                                                                                              | `apps/web/components/product/index.tsx` (`Inbox`, "Awaiting review"), `/api/product/workspace`, `packages/contracts/src/product.ts`                                  |
| S03 one update → proposed records | **Working UI, deterministic proposals.** No on-screen staging label since D8; the review pane shows the original text, proposed activity/contributions/need and unresolved fields, each tied to source evidence. In the demo profile the proposal is an explicitly authored fixture, not live model output.                      | `packages/db/src/demo-data.ts` (`proposal`, `modelVersion: synthetic-fixture-v1`), `packages/ai/src/extraction.test.ts`, review pane in `product/index.tsx`          |
| S04 approve and ledger            | **Working.** Accepting a proposal persists the activity and per-volunteer contributions; one shared hour produces two 60-minute contributions. Approved time is the reporting ledger.                                                                                                                                            | `packages/contracts/src/index.ts` (review command, `approve` transition), `packages/db/src/repositories/domain.ts`, `/api/product/activity`, `/workspace/activities` |
| S05 possible duplicate            | **Working review gate, partial automatic matching.** A later update is flagged with an unresolved `duplicateCandidate`, and a second contribution for the same person/activity is refused as `duplicate-contribution`. There is no fuzzy auto-merge and no silent deletion: staff decide.                                        | `demo-data.ts` (`duplicate` run), `packages/db/src/repositories/domain.ts:454`, review pane "Unresolved in original proposal"                                        |
| S06 ownership and acknowledgment  | **Working assign/acknowledge/resolve; escalation implemented but not captured.** `assign` requires an owner; `acknowledge` is a separate staff action; `resolve` records an outcome. The worker escalates overdue acknowledgments (`escalateOverdue`). No clock is changed for the video, so escalation is narrated, not filmed. | `product/index.tsx` (`Need`, "Manage need"), `/api/product/need-transition`, `apps/worker/src/index.ts:106`, `packages/db/src/repositories/follow-through.ts:459`    |
| S07 weekly report                 | **Working aggregate report; no per-number drill-down on the report page.** Approved minutes/hours, contributions, activities, open/resolved needs, pending unknowns and excluded unknown-date rows are computed server side. Traceability comes from the inbox evidence pane and the audit history, not from clicking a metric.  | `apps/web/components/product/index.tsx` (`Summary`), `packages/contracts/src/reports.ts`, `/api/product/reports`, `/api/product/audit`, `/workspace/history`         |
| S08 close                         | **Designed graphic.** Repository URL, MIT licence and synthetic-data/AI-narration disclosure.                                                                                                                                                                                                                                    | `video/src/scenes/Closing.tsx`, `LICENSE`                                                                                                                            |

## Verified behaviour the narration relies on

- Review-all policy: `organization_settings.automation_policy = 'review-all'` in
  the demo profile, so nothing is approved without a staff decision. A
  `validated-auto-record` policy also exists and is exercised by the 28-source
  acceptance harness; the video only shows review-all.
- Ledger invariants: approved contributions need a resolved volunteer and a
  duration (`contributionRecordSchema` superRefine); unknown duration stays
  `null` and is reported as pending, never zero.
- Tenant scope: every product query is organization-scoped and roles come from
  the server (`packages/db/src/repositories/memberships.ts`, `product.ts`
  "Private arrays are empty for readers").
- Needs provenance: a need created from a review proposal is provisional until
  staff approve; rejection does not silently withdraw it (UI copy in the review
  pane).

## Simulated, staged or unverified — stated on screen

| Item                        | Reality                                                                                                                                                                                        | Where it is disclosed                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Chat messages in S01        | Fictional reenactment                                                                                                                                                                          | "Illustrative story" headline inside the scene; the corner label was removed (D8) |
| Proposal content in S03     | Deterministic synthetic fixture output; every demo proposal is authored in `demo-data.ts`                                                                                                      | `docs/recording-runbook.md`, this audit; S03 label keeps capture origin visible   |
| Live OpenAI extraction      | Implemented (`packages/ai/src/openai.ts`, `service.ts`) and gated by budget/pricing configuration. **Not verified in this environment**: no provider key, so no live extraction call was made. | Readiness report; do not claim live-model behaviour from the demo                 |
| Telegram channel            | Real adapter and webhook route exist (`apps/web/app/api/telegram/webhook/route.ts`); the demo uses the replay transport. No live Telegram check was run.                                       | Not shown in footage; audit only                                                  |
| Email/notification delivery | SMTP delivery jobs exist; the demo shows one terminal failed attempt. No real mail was sent.                                                                                                   | Not filmed; delivery is explicitly "not acknowledgment" in narration and UI       |
| Escalation                  | Worker code path exists; no elapsed-time demo                                                                                                                                                  | Narrated only, runbook notes the worker must be stopped during capture            |
| Duplicate matching          | Staff-reviewed flag and hard duplicate constraint, not fuzzy auto-merge                                                                                                                        | Narration says "Relay raises the possible duplicate for staff review"             |

## Excluded from the video

- Live model extraction claims, accuracy or time-saving figures, adoption
  numbers, beneficiary outcomes: none are measured and none are claimed.
- Public judge accounts, Telegram linking, CSV/photo import and the volunteer
  receipt flow: implemented, but not needed for a three-minute story; adding
  them would exceed the runtime.
- Hosted footage: blocked on credentials (see above), so no hosted scene exists
  in this delivery.

## Environment and setup gaps found

1. **Hosted credentials missing.** `video/.env.local` does not exist; every
   `VIDEO_*_PASSWORD` is unset. Hosted provisioning and capture are blocked.
2. **No per-account generated passwords in the demo seed.** The shipped demo
   profile provisions verified synthetic identities with one intentionally
   public demo password (`apps/web/lib/auth/demo.ts`). The brief's
   "generate a unique password per new identity" requires a scripted seed that
   accepts a password per identity — a domain/seed change owned by another lane,
   not something this workspace should fake. `video:provision` therefore reuses
   the dedicated synthetic demo accounts and records the gap.
3. **Organization naming.** The brief names `Tidepath Family Alliance —
   Recording` and a `Mangrove` isolation tenant. The shipped profile has
   `Tidepath Mutual Aid` (`tidepath`) and `Harbor Neighbour Network` (`harbor`).
   The video uses the shipped synthetic tenant rather than inventing a new seed;
   ids in the scenario fixture are the application's literal ids, not UUIDs.
4. **No second volunteer identity.** Ana's later duplicate report exists as a
   fixture authored by the demo volunteer. A separate Ana account would need a
   seed change; S05 therefore shows the volunteer's own later update.
5. **No ElevenLabs credentials.** Narration is blocked unless supplied audio is
   used; a clearly labelled local scratch voice may be generated for timing
   verification only.
6. **Live provider checks not run.** No OpenAI, SMTP or Telegram call was made
   from this workspace.
