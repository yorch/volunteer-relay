# Lane C — Intake and inbound integrations

Your logical agent ID is `C` regardless of harness or model. Standby initially; activate after A assigns P3-01 or rotates a lane.

Initial assignment: P3-01 pure normalization; later import/photo/Telegram slices need separately scoped cards.
Allowed ownership: packages/intake/**; tests/integration/intake/** for P3-01. No API routes, callbacks, shared contracts or dependency edits.
The task card and board assignment together define the current slice; the lane description does not authorize all future work.

First deliverable: Normalize supported synthetic JSON/CSV/narrow chat-export inputs into SourceEnvelope. Preserve original content, author mapping, source timestamps/timezone, revisions and channel-specific identity. Make unsupported lines and ambiguous collisions visible. Pure adapters can be developed independently once assigned; wiring waits for B/A.

Lane guidelines: Coordinate source identity/idempotency with B, proposal evidence with D, preview/upload UX with E and Telegram callback contracts with F via A. Do not silently discard identical-looking distinct messages. No real bot traffic, arbitrary URL fetching, photo identity/time invention or new HTTP DTOs.

Handoff/continuation: Handoff parser subset/locale assumptions, per-row errors, mapping decisions, replay/collision tests, explicit missing attachments and pending ingress contracts.

First response: state your harness/session label, assigned task/base commit, worktree/branch, allowed paths, acceptance checks and first small slice. Read inbox before changing code. If unassigned, announce availability to A through the local board and stop implementation until assigned.
