# ADR 0009 — M1 ledger, need lifecycle and attachment reads

Accepted 2026-11-08 for P1-13. Closes the remaining M1 domain gate (core activity/contribution/need transitions and cross-tenant attachment denial). Proposal persistence, review workflow, reconciliation, policy processing, routing/escalation, queue dispatch, HTTP routes and reporting filters remain later gates.

## Contracts

`packages/contracts` adds `LedgerService`, `NeedService`, record/command/query schemas, `contributionTransitionRules`, `needTransitionRules` and `ledgerSummarySchema`. Existing v1 wire shapes are unchanged. `AttachmentStore.read` now takes `(context, sourceId, attachmentId)` because attachment identity is organization + source + attachment (ADR 0005); it had no implementation or consumer.

Identifiers for new activities, contributions and needs are server-generated opaque IDs (injected generator, default `crypto.randomUUID`). Every mutation carries `idempotencyKey`; mutations of an existing aggregate carry `expectedRevision`. Revisions start at 1 and increase by one per mutation of that aggregate.

## Ledger rules

- One activity may have several contributions; a membership has at most one _active_ (pending or approved) contribution per activity. A second one is CONFLICT; reconciliation/linking is M4. After rejection or supersession a new contribution for that membership may be added.
- Duration is integer minutes 1–1440 or null (unknown). Unknown is never zero.
- Approval requires a resolved membership and a known duration (VALIDATION otherwise). The database enforces the same invariant. Therefore approved totals are always sums of known minutes, and unknown-duration or unresolved-volunteer work stays visibly pending.
- `correct` amends duration in place on a pending or approved contribution (same ID, next revision) with a reason; the previous values remain in the audit history. `supersede` removes a pending or approved contribution from the active ledger with a reason. `reject` applies to pending only.
- `ledger.changed` is emitted only when the approved ledger changes: approve (`approved`), correction of an approved contribution (`corrected`), supersession of an approved contribution (`superseded`). Pending/rejected-only changes emit audit history but no ledger event.
- Contribution memberships must be live members of the tenant when recorded. Later membership removal preserves the historical membership ID and approved minutes, and does not block approving that volunteer's pending work.

## Need rules

`needTransitionRules` is the full state machine: assign from new/assigned/acknowledged → assigned (clears acknowledgment; new owner must be a current owner/coordinator membership of the tenant); acknowledge from assigned → acknowledged, only by the actor whose membership is the current owner; resolve from new/assigned/acknowledged → resolved with a resolution; cancel from new/assigned/acknowledged → cancelled with a reason (also how a provisional alert is withdrawn); reopen from resolved/cancelled → new with a reason, clearing owner, acknowledgment and the assignment-scoped `acknowledgeBy` so routing is explicit (`dueAt` is need-level and kept). A transition not permitted from the current status is CONFLICT. Every need mutation, including creation, emits `need.changed` with the resulting status and provisional flag. Escalation, deadlines policy and notification are M5; `dueAt`/`acknowledgeBy` are stored values only.

## Authorization

All operations call `AuthorizationService.require` against live membership first; system actors are denied (no worker authority contract yet). Ledger mutations and `getActivity` require `review:write`. `listContributions` returns all tenant contributions for `review:write`, only the caller's own for a volunteer (`source:submit` without `review:write`), and FORBIDDEN otherwise. `summarize` requires `report:read`. Need operations require `need:manage`. Attachment reads follow SourceRepository.get evidence rules: staff (`review:write`) read any attachment in the tenant; a volunteer reads attachments only of sources they authored; report-readers and system actors are FORBIDDEN before any lookup. Unknown and cross-tenant IDs are NOT_FOUND without disclosure. Referenced memberships or origin sources outside the tenant are VALIDATION with a field name, never a hint about another tenant.

Idempotent replay is checked after authorization and before revision/state checks: the same key with an identical canonical command returns the stored original result without new effects; the same key with a different command is CONFLICT. A replay still requires current authority.

## Persistence

Migration 0002 (B-lane rules apply; 0000/0001 stay immutable):

- `activity`, `contribution`, `need`: composite primary keys `(organization_id, id)`, organization FK, revision, created/updated timestamps, origin columns (`origin_kind` source|staff, `origin_source_id`, `origin_source_revision`, `origin_reason`) with a consistency CHECK and a composite FK to `source_revision` for source origins. `contribution (organization_id, activity_id)` references `activity`. CHECKs mirror contract enums, minutes bounds, date precision, the approved invariant and need status/field consistency. A partial unique index enforces one active contribution per (organization, activity, membership).
- Membership references on contributions and need owner/acknowledger use the existing tenant-scoped historical anchor `source_author (organization_id, membership_id)`, upserted when a live membership is first referenced. This reuses the reviewed column-specific `ON DELETE SET NULL (current_membership_id)` behavior; membership deletion never deletes or blocks ledger rows. The anchor never grants authority.
- `domain_audit_event`: one immutable row per aggregate revision `(organization_id, aggregate_type, aggregate_id, aggregate_revision)` unique, with action, actor, correlation ID, optional reason and `before`/`after` record snapshots. This is the history that preserves prior contribution revisions.
- `domain_command`: `(organization_id, idempotency_key)` primary key, command type, canonical command digest and the exact stored result for replay. Immutable.
- Both new history tables reuse `relay_reject_evidence_update()` BEFORE UPDATE triggers.
- `outbox_event` accepts `ledger.changed` and `need.changed`. Its source-revision FK becomes conditional through stored generated columns that are non-null only for `source.received`, preserving the reviewed source-event provenance guarantee while allowing other aggregates. The aggregate uniqueness index remains the event idempotency boundary; event IDs hash the JSON tuple `[organizationId, type, aggregateId, aggregateRevision]`.

Each mutation writes its aggregate change, audit row, command row and any outbox event in one transaction. Optimistic updates use `WHERE revision = expectedRevision` (and the expected status); zero rows is CONFLICT. Unique/serialization races are classified from the winning row, as in the source store. Storage failures surface as fixed `DEPENDENCY_UNAVAILABLE` messages with no driver detail or record text.

Attachment bytes come from an injected blob reader port keyed by `storageKey`; the reader verifies byte length and SHA-256 against stored metadata. The private filesystem adapter and HTTP route arrive with photo upload (P3-02). M1's gate is the tenant-authorized domain boundary over real PostgreSQL metadata.
