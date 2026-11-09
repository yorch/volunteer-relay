# 0012 — Platform operator console (cross-organization administration)

Status: accepted (2026-11-09). Additive; no schema version change, no migration, no change to tenant roles or tenant routes.

## Context

The product has per-organization owner administration (`/workspace/members`) and an operator-only CLI for the first organization (`docs/provisioning.md`). Nothing in the application lists organizations or lets anyone fix a missing or wrong owner across them. `docs/adr/0007-m1-auth-http-composition.md` deliberately exposed no organization creation or admin endpoint, so the gap was closed with shell access and a database URL — the worst place to require it, and unattributable.

Three constraints shaped this decision:

1. Tenant authority is server-resolved from a verified session plus live membership; a parsed organization id never grants anything (`docs/CONTRACTS.md`).
2. `roleSchema` is a frozen contract vocabulary with a database `CHECK`; adding `operator` to it would make a global capability grantable through tenant administration.
3. Only B owns migrations and their ordering, so a slice that needs a new table, column or `CHECK` value cannot be landed by the coordinator alone.

## Decision

Operator status is **deployment configuration bound to an account**, and the console is a **separate transport surface**.

- `OPERATOR_ACCOUNTS` (optional, `packages/config`) holds comma-separated `userId:email` entries, at most 20. Absent or blank disables the console. A malformed list refuses start-up, because a silently empty allowlist looks identical to a working one with no operators.
- Authority requires **both** the immutable user id and the account's own address to match a configured entry, on a session whose email is verified (`productSessionUser`). An address alone is not ownership of an account: public sign-up lets anyone register an unclaimed address and wait for the real person to click the verification link, which marks the squatter's account verified without rotating its password or sessions. The immutable id removes that takeover path; the address keeps a hand-edited list honest.
- Reserved `.invalid` domains are refused, and `OPERATOR_ACCOUNTS` is refused while `DEMO_MODE=true`, because demo credentials are public and would share one root account.
- `operator` is **not** a contract role, is never written to `member.role`, and cannot be invited, granted or revoked inside a tenant.
- `/api/operator/*` is a new surface (`apps/web/lib/operator/**`). It has no `TenantContext`, does not call the product handler, product extensions or tenant authorization, and no product route gains operator awareness. `apps/web/lib/operator/boundary.test.ts` fails if that changes.
- Every state that is not a live configured operator answers `NOT_FOUND`, so the console's existence is not an account oracle. A dependency failure stays `DEPENDENCY_UNAVAILABLE` so an outage does not read as a permission problem.
- Mutations require the configured application origin, a session created within the last 30 minutes, and per-operator fixed-window limits (120 reads / 15 min, 20 writes / hour, in-memory, one web replica).
- Roles the console may change are ownership only: `coordinator|volunteer|report-reader → owner` (grant) and `owner → coordinator` (revoke). Every command carries `expectedRole` and conflicts on a stale view. An operator may not target their own membership, so a global capability can never be converted into a tenant role.
- The last-owner guard refuses any revocation that would leave zero owners, computed under `for update` locks on the target membership and every owner row of that organization.

Reads expose `organizationId`, name, slug, created time, member counts, pending invitation count, and owners as `{ membershipId, name, maskedEmail, joinedAt }` — enough to identify a person, not a cross-tenant address directory. Search matches organization name and slug only; there is no endpoint that returns an unmasked address.

Organization creation mirrors `scripts/provision-organization.ts`: a verified credential account, case-insensitive name and slug uniqueness under an advisory lock, a validated IANA timezone, contract-validated initial settings, one owner membership, and an audit row.

## Audit

Cross-organization changes write `organization_audit_event` rows for the **target** organization in the same transaction as the change, so a failed audit write rolls the change back:

- `action='member.role'`, `phase='applied'`, `target_id=<membership>`, `actor={"kind":"operator","userId":…}`, `before`/`after` role, `correlation_id`.
- Organization creation records the initial owner grant with `after={"role":"owner","organizationCreated":true,…}`.

The operator's address is deliberately **not** recorded: the actor is rendered to tenant owners and coordinators in their own history view and the table rejects updates and deletes, so anything written there is permanent and cross-tenant visible. Owned history therefore shows an unattributed "Recorded actor" for these rows — a deliberate trade against storing a permanent cross-tenant address in a tenant-readable table.

## Rejected alternatives

- **`operator` in `roleSchema` / a `member` row.** Makes the capability grantable, invitation-able and tenant-visible; also breaks the "revocable by configuration" property.
- **A database operator table.** Needs a B-owned migration and adds an in-band grant path with its own lifecycle; not justified at this scale. Worth revisiting when audited grants or more than a few operators are needed.
- **Email-only allowlist.** Opens the pre-registration/verification takeover path described above.
- **Reusing `/api/product/*` with a synthetic tenant context.** Would let global authority travel through tenant code, and the audit and authorization helpers assume live membership.
- **Unmasked owner addresses and address search.** Turns the console into a cross-tenant address harvester.
- **Exposing the console link to everyone.** The workspace asks `/api/operator/session` once and only renders the link when it succeeds.

## Known gaps and follow-ups (B-owned migration)

These are accepted for this slice and recorded here rather than silently omitted:

1. **No database-level last-owner invariant.** The guard holds against concurrent operator changes (row locks) but not against a concurrent tenant-initiated self-demotion through Better Auth, whose role checks run without a transaction lock. That race pre-exists this change between two owners. Proposed close: an `AFTER UPDATE OF role OR DELETE` trigger on `member` that locks the organization row, recounts owners when an owner row loses ownership, and raises if none remain (skipping rows deleted by an organization cascade).
2. **`action='member.role'` for organization creation.** `organization_audit_action_check` has no `organization.create` value and adding one is a migration. The interim encoding is documented above and carries `organizationCreated: true` in `after`.
3. **Provisioning duplication.** The console and `scripts/provision-organization.ts` both create an organization. The shared transaction helper (including the advisory lock and initial settings) should move into one B-owned module; until then both carry a comment pointing at each other.
4. **No owner notification.** Owners are not told when an operator grants or removes ownership. The audit row and the next history read are the only signals.
5. **No audit of reads, no zero-owner recovery flow, no organization deletion/archival/rename, no member removal or invitation from the console.**
6. **Rate limits are per process.** A horizontally scaled web tier would need a shared store, as the auth limiter already documents.

## Post-implementation adversarial review

A second independent adversarial pass over the implementation found no tenant-isolation escape, injection or ordinary-user escalation, and rejected the first cut for a functional defect and missing database evidence. Everything below was fixed in the same change:

- **Detail route missing.** The console called `GET /api/operator/organization` and the transport never served it, so "Manage owners" was dead. The route is served (strict `organizationId` parameter only), and `apps/web/lib/operator/http.test.ts` now asserts every path the console calls is served.
- **Stale detail responses.** A slow response for organization A could render under B's heading and drive a change against the wrong organization. Only the newest request renders, and a response whose body names another organization is treated as a conflict.
- **Separation of duties.** The console now refuses to make the operator the owner of a new organization, and refuses ownership changes in any organization the operator already belongs to; member administration there stays in the tenant UI. Two operators cross-granting remains possible and is accepted.
- **Cursor correctness.** The cursor now carries the exact `lower(name)` Postgres sorted by, so JS and Postgres case folding cannot skip a row, and the encoded bound is 1024 characters so multi-byte names cannot make the next page permanently unrequestable.
- **Lock order.** The organization row is read, not locked (`for share`), and owner/member rows are locked `order by id for no key update`. This avoids inverting the lock order used by the tenant paths and by the planned owner trigger, avoids deadlock between two operators, and stops blocking foreign-key checks from tenant inserts.
- **Failure visibility and status.** Failures are logged with operation, correlation id and code only; a unique violation on a concurrent slug collision is a `CONFLICT` rather than a retryable outage; a rate-limited response carries `Retry-After`; the method allowlist is evaluated after authority resolves so an unauthorized method cannot reveal whether the console is configured.
- **UI states.** Denial, rate limiting, outage and a stale session render differently, with a retry action and a sign-in path; losing authority clears the list and detail instead of leaving cross-organization data on screen; the reload after a mutation uses the submitted search, not unsubmitted text; the tenant history shows operator audit rows as "Ownership changed by a platform operator" by "Platform operator".
- **Real database evidence.** `tests/integration/auth/operator-console.test.ts` runs against PostgreSQL: creation writes organization, settings, membership and audit together; concurrent demotions serialize to exactly one success with one owner and one audit row; a forced audit failure rolls the role change back; last-owner revocation is refused; list and detail return only masked addresses.

Remaining accepted risks, unchanged by the review: the tenant self-demotion race still needs the trigger above; assigning a first owner by email inherits the pre-registration risk described earlier (an operator must verify the account with the person, and invitation-based assignment is the real fix); `actor.userId` reaches the organization's own owners and coordinators through the audit view even though the address does not; rate limits are per process; and the console opens its own connection pool rather than sharing the product one. Operator reads are not audited.

## Consequences

Operators can see every organization and repair or transfer ownership in the application, with an attributed audit trail, without widening any tenant route or tenant role. A deployment that sets no `OPERATOR_ACCOUNTS` carries no operator code path beyond a 404 handler and no cross-organization SQL. The follow-ups above are deliberately separated so that migration-bearing work stays with its owner.
