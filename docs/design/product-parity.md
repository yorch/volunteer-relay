# Product UI and prototype comparison

## Current result — 2026-11-08

The full product UI revamp is implemented and independently reviewed. The application now carries the reference's warm off-white/sage/teal palette, bundled Manrope and DM Sans typography, compact staff shell, review workspace, status-based needs board and board-ready reports. See the [production screenshot gallery](revamp-gallery.md). The initial gap audit below is historical and superseded by this result.

| Area                              | Implemented result                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell, landing and authentication | Reliable SVG branding, locally served licensed fonts, grouped navigation, breadcrumbs and a compact keyboard-operable mobile menu. Volunteer pages have no staff navigation or fake phone frame.                                       |
| Product overview                  | Authorized queue, need and approved-time data with prioritized work; no prototype counters or fabricated weekly totals.                                                                                                                |
| Inbox                             | Search and status filters, explicit source selection, evidence/proposed-field panels, mobile review staging and restored focus. Filtering never silently selects another proposal or leaves hidden-source decision actions active.     |
| Needs                             | New/assigned/acknowledged columns, urgent-first ordering, urgency/provisional badges and secondary creation/management controls. Completed work remains available.                                                                     |
| Ledger                            | Compact records with activity type/date, contribution status and source-specific authorized evidence. Corrections retain explicit reasons and optimistic revisions.                                                                    |
| Reports                           | Four leading metrics, compact filters and a detailed summary table. Human-readable durations and a CSV link use the same authoritative query.                                                                                          |
| Volunteer                         | Focused text/photo entry, recognizable own-update summaries, dates/status labels and private evidence. Evidence opening scrolls/focuses the heading; closing returns to its trigger. Switching updates clears old evidence and errors. |
| Imports                           | File/preview/confirmation hierarchy with person and photo mapping controls instead of JSON. Exact filenames, unknown authors, duplicate mappings and replay behavior remain explicit.                                                  |
| Administration                    | Named staff routing, protected fallback selection, compact member/preferences panels, readable audit history and responsive delivery details. Provider acceptance remains distinct from acknowledgment.                                |
| Retention                         | Source preview, explicit reason and acknowledgment retain the existing owner/revision/privacy gates. No real evidence was erased for visual review.                                                                                    |

### Verification

At UI commit `ba21950`, all 264 Chromium browser cases passed across 1440/1024/390/320px; the production-image follow-up inspected populated core/role screens and resolved the final volunteer badge/focus issues. Earlier full-page visual capture covered all twelve owner routes at the four sizes; final follow-up captured 24 representative owner/volunteer/multi-account page-size combinations with no document overflow. Independent review also checked source filtering, keyboard behavior, role boundaries and matching report/CSV queries. The 254 PostgreSQL product cases include current-member metadata scoping and redaction exclusion.

These checks establish the measured revamp, not pixel identity or a formal accessibility certification. Native-device, Firefox/WebKit and assistive-technology certification were not performed. Correction/record revision references and the extra operational/privacy screens are deliberate additions to the reference. The prototype's sample counters, inferred hour defaults, localStorage, unrestricted role switching and simulated phone chrome were not copied. Live providers, public TLS and fresh-host recovery remain separate release gates.

## Historical initial audit

Everything below records the pre-revamp snapshot and its findings; it does not describe the current visual acceptance status.

### Initial audit — before the revamp

Initial audit on 2026-11-08, before the revamp. **At that checkpoint, visual and UX parity was incomplete.** The implemented product follows the reference palette and shell direction, but the browser acceptance results establish functional behavior, not fidelity to the prototype. Track remaining work in [P2-06](../tasks/P2-06.md); implementation through M2–M7 does not close this design gate.

## Comparison method and limits

Rendered the unchanged [reference](../../design/reference/prototype.html) in Chromium at 1440×1000 and 390×1000. Rendered five corresponding authenticated production pages at the same viewports: inbox, needs, activities, reports and import. The reference's seven screens were rendered at both widths. Inspected desktop inbox, needs, activities and reports, and mobile inbox screenshots. All 24 rendered page/viewport combinations had no document-level horizontal overflow; this is not a complete accessibility assessment.

Production web image was built at `dd989a1`; later `40742ce` changes only worker image readability, and subsequent changes through `5ed23ca` are documentation. The running application uses a synthetic owner organization with one queued source, one approved 60-minute contribution and one acknowledged need. Reference figures are fictional illustrative counters, so numerical equality and populated versus empty queue differences are not visual defects. The populated production proposal editor and volunteer experience were not directly compared in this live pass. Their behavior has separate controlled browser coverage; design parity remains unverified.

The reference's remote font request was blocked for a deterministic offline comparison. Both images use available fallbacks; exact Manrope/DM Sans rendering was not established. The product names those families but does not bundle their files. The prototype remains unmodified.

## Findings

| Area                       | Current match                                                                                                            | Remaining difference / acceptance work                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette and surfaces       | Warm off-white, sage navigation, dark teal actions, rounded bordered cards and selected navigation follow the reference. | Product borders are stronger, cards more rounded, type and controls larger, spacing less compact. Reconcile tokens while preserving contrast and touch targets.                                                                                                              |
| Staff shell                | Sidebar, organization identity, top bar and responsive navigation exist.                                                 | Reference has compact navigation, icons/counts, breadcrumbs and profile hierarchy. Product exposes many administration links equally, has a plain tagline and account link, and a default outer body margin. On mobile, navigation takes about 400px before content.         |
| Overview                   | Staff home resolves to the inbox; volunteers and report readers have role-specific landing behavior.                     | No dedicated prototype-style operational overview with authorized summary metrics and prioritized work. This is a product overview gap, unrelated to the excluded orchestration dashboard.                                                                                   |
| Inbox                      | Original evidence inspection, queue states, review and retry/reprocess controls are implemented.                         | Live queued-source view is dominated by large processing cards and raw identifiers. The reference uses summary metrics, search/tabs and a message-list/evidence/proposed-fields workspace. Populated proposal layout parity needs a dedicated comparison.                    |
| Needs                      | Authorized lifecycle, ownership, acknowledgment, deadlines and provisional states exist.                                 | A large always-open creation form precedes a vertical list of action forms. The reference is an immediately scannable three-column board: needs an owner, waiting for acknowledgment, in progress. Lifecycle controls need progressive disclosure and clear status grouping. |
| Activities                 | Real ledger and reasoned corrections are available.                                                                      | An always-open entry form and editable contribution cards replace the reference's compact ledger table and source links. Make the ledger primary and entry/correction secondary. Preserve separate contributions per activity.                                               |
| Reports                    | Approved totals, pending/unknown exclusions, filters and matching aggregate CSV exist.                                   | Tall filter controls precede many oversized metric cards; reference leads with compact summary cards and a board-ready table. Humanize duration formatting: the live acknowledgment average shows an unrounded fractional minute.                                            |
| Imports                    | Preview/confirm, mapping and private attachments are implemented.                                                        | Functional controls extend beyond the reference's simple import card. A focused visual/interaction review of mapping, errors and confirmation is still required.                                                                                                             |
| Volunteer                  | Separate permission-scoped form/status flow exists and has controlled browser tests.                                     | Production volunteer screenshots were not captured in this owner-only pass. Compare as a volunteer before accepting parity. Do not copy the reference's fake phone frame or expose staff navigation.                                                                         |
| Typography and iconography | Accessible system fallbacks are usable.                                                                                  | Fonts are not locally bundled; logo glyph is missing in the inspected browser. Use reliable assets and decide intentionally whether to bundle reference fonts.                                                                                                               |

## Evidence

The screenshots below contain synthetic data only. They show the different layouts; no pixel-difference score or full parity claim is made.

| Screen           | Reference                                                   | Running product                                         |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| Needs, desktop   | [Reference](evidence/2026-11-08/prototype-needs-1440.png)   | [Product](evidence/2026-11-08/product-needs-1440.png)   |
| Reports, desktop | [Reference](evidence/2026-11-08/prototype-reports-1440.png) | [Product](evidence/2026-11-08/product-reports-1440.png) |
| Inbox, mobile    | [Reference](evidence/2026-11-08/prototype-inbox-390.png)    | [Product](evidence/2026-11-08/product-inbox-390.png)    |

## Preserve deliberate behavioral differences

Keep live tenant/role checks, authoritative approved-ledger totals, explicit unknowns, source revisions, optimistic concurrency, evidence or staff reasons, policy snapshots and provisional alerts. Do not restore the prototype's localStorage persistence, inferred one-hour defaults, fake totals or unrestricted role switching. Clarification delivery needs a real authorized workflow before a reference-only send button can be presented as operational. The design pass must preserve the independently authored fixture oracle and all currently validated behavior.
