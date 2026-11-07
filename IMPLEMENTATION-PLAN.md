# Volunteer Relay — Full Implementation Plan

Date: November 7, 2026. Working name, subject to change.
Status: implementation plan; foundation and first implementation slices are built. Current milestone gates and acceptance evidence are tracked in docs/STATUS.md.

## 1. Outcome and scope

Build a multi-organization volunteer operations application for challenge #5. Volunteers report through a mobile web page, Telegram, or staff-imported chat exports. Text and photos become traceable activity records, volunteer contributions, and actionable needs. Staff resolve ambiguity, acknowledge assignments, and produce defensible totals.

The product must demonstrate one fictional week end to end: hours counted once, urgent needs reaching accountable staff the same day, and board totals backed by evidence. All seed data, photos, names, locations, and demo messages must be synthetic. The repository must be public with an MIT license by submission.

Full scope includes authentication, organization isolation, web intake, imports, Telegram, photos, structured AI extraction, deduplication, corrections, review, configurable automation, assignment and escalation, in-app/Telegram/email notifications, reporting, audit history, and single-host operations. Audio, inventory, counseling records, clinical assessment, WhatsApp integration, resource procurement, and autonomous emergency response are outside this release.

Integration policy: follow AGENTS.md for Conventional Commits and linear history. A chooses rebase plus fast-forward or squash per branch; no new merge commits. Existing history is preserved.

## 2. Confirmed decisions and planning defaults

| Area | Decision | Status |
|---|---|---|
| Application | Next.js and TypeScript, one repository, separate worker | Confirmed |
| Runtime | Node.js 26 for application, worker, scripts, and tests | Confirmed |
| Package manager | Bun workspaces and committed Bun lockfile | Confirmed |
| Database | PostgreSQL with Drizzle | Confirmed |
| Quality | Biome and Vitest; no ESLint or Prettier | Confirmed |
| Deployment | Docker Compose on one host | Confirmed |
| Authentication | Better Auth, email/password; seeded staff and volunteer accounts | Confirmed |
| Tenancy | Multiple nonprofits per deployment | Confirmed |
| Intake | Web, file imports, Telegram bot; text and photos | Confirmed |
| Automation | Organization-selectable review-all or validated-auto-record | Confirmed |
| Notifications | In-app, Telegram, email | Confirmed |
| Queue | pg-boss using PostgreSQL, with application outbox | Planning default |
| UI | Tailwind CSS, accessible reusable components | Planning default |
| Email | SMTP adapter; Mailpit in development/demo | Planning default |
| Files | Private filesystem volume behind authenticated routes; storage adapter boundary | Planning default |
| Bot tenancy | One deployment bot, explicit organization selection per conversation | Planning default |
| Language | English/Spanish intake; English UI initially | Planning default |
| Testing UI | Small Playwright smoke suite in addition to Vitest | Planning default |
| License | MIT | Planning default |

Bun installs dependencies and dispatches scripts; it does not replace Node as the runtime. Pin exact compatible dependency versions during phase 0, use frozen installs, and verify actual process runtimes in CI and containers. Avoid Bun-specific application APIs.

Choose the OpenAI model through configuration after testing structured extraction and image support against fixtures. Record model/prompt/schema versions; do not hard-code an assumed latest model. Pin Node 26 patch/container digest during implementation. Provider credentials and a public HTTPS endpoint are deployment inputs, not blockers for development with adapters.

## 3. Product workflows

### Volunteer

Sign in, select an organization, write an update, attach a photo, submit, and see receipt/processing status. See own contributions, requests for clarification, and corrections. Link Telegram through a short-lived, single-use account-link token initiated in the authenticated app. Volunteers cannot browse other families, staff queues, or organization-wide reports.

### Coordinator

See new updates, uncertain proposals, urgent needs, and failed processing. Review source evidence alongside proposed fields; accept, edit, reject, or link to an existing activity. Assign a need and track acknowledgment/resolution. View missing-hour and unresolved-identity queues separately from approved report totals.

### Organization administrator

Invite members; manage roles, routing categories, notification preferences, acknowledgment deadlines, timezone, automation policy, and reporting settings. Review audit history. A person may belong to multiple organizations with different roles.

### Board/report reader

Read aggregate reports without access to sensitive source messages or beneficiary details. Download aggregate CSV. Operational evidence drill-down is restricted to authorized staff.

### Need lifecycle

New → assigned → acknowledged → resolved. Cancellation and reopening require a reason. Escalation is a recorded event with reassignment/notification, not an alternative terminal state. Track urgency, due time, acknowledgment deadline, owner, and resolution independently. A notification accepted by a provider is not acknowledgment by a person.

## 4. Architecture and repository boundaries

| Path | Responsibility |
|---|---|
| apps/web | Next.js pages, server-side authorization, authenticated API routes, webhook ingress |
| apps/worker | Queue consumers, scheduler, extraction orchestration, outbox delivery |
| packages/contracts | Shared validation schemas, event types, API payloads, enum definitions |
| packages/db | Drizzle schema, migrations, tenant-aware repositories, transaction helpers |
| packages/domain | Activity, contribution, review, need and reporting use cases |
| packages/ai | OpenAI adapter, prompt templates, extraction validation, evaluation harness |
| packages/intake | Normalization, import parsers, Telegram payload mapping, attachment handling |
| packages/notifications | In-app, SMTP and Telegram adapters, templates, delivery state |
| packages/config | Validated environment configuration and shared TypeScript settings |
| fixtures | Synthetic messages, photos, expected records and report totals |
| tests/integration | PostgreSQL-backed integration and tenant isolation tests |
| tests/e2e | Minimal browser smoke flows |
| infra | Dockerfiles, Compose, reverse proxy and operational scripts |
| docs | Architecture decisions, contracts, runbooks, demo script |

Next.js accepts requests and persists source evidence plus an outbox entry in a transaction. The worker dispatches and processes jobs. Domain services remain independent of HTTP, Telegram, and model SDK objects. Background processing never relies on the Next.js request remaining open.

Use pg-boss for durable work and schedules; use a transactional outbox to avoid the gap between committing domain data and enqueueing/delivering effects. Expect repeated delivery and process restarts. Unique constraints and idempotent domain handlers prevent duplicate business effects. Do not claim exactly-once delivery for external services.

Private attachments live on a persistent shared volume, outside public web assets. Only authenticated, tenant-authorized routes stream them. Local disk is suitable for one host; retain an interface for future object storage. Include disk capacity monitoring, backup, file type/size restrictions, and metadata stripping for derived images.

### Design reference and UI implementation authority

The user-supplied interactive reference is `design/reference/prototype.html`. Its visual direction, source/proposal hierarchy, needs ownership board and volunteer form guide UI work. Read `docs/design/prototype-review.md` and ADR 0003 for the review and phase map. Preserve the standalone HTML as a reference; do not embed it in the app or port its localStorage arrays, inline handlers, assumed durations, sample counters or unrestricted navigation. The plan, canonical contracts and independent fixture oracle govern behavior and correctness.

E owns one shared visual foundation through P2-00, independently of B/C/D/F service implementation; dependency additions and role-aware layout wiring remain A/B-coordinated. P2-02 consumes it for fixture-backed mobile intake and staff review, integrating with real services at M2. P3-04 adds import/photo UI at M3. P5-03 adds a basic needs board at M2 only once B's tenant-aware lifecycle services and A's contracts exist, then delivery/deadline/escalation surfaces at M5. P6-01 adds the basic ledger at M2 and approved-query reports/CSV at M6. M4 reconciliation, correction and automation behavior is reflected in the review UI only after corresponding B/D services and A contract extensions land. Overview composes those authorized queries rather than inventing aggregate logic.

UI acceptance includes actual desktop/tablet/mobile review, accessible labels/contrast/focus, loading/error/empty/unknown/provisional states, selection consistency under filters, role-specific navigation and matching domain/report totals. The prototype's JavaScript behavior was inspected in a stubbed DOM; browser visual verification was blocked by the unavailable host and remains required for translated UI. A supplies the planned Playwright runner before browser acceptance is claimed. This reference intake is planning/design work only and does not implement or complete any M1–M7 workflow.

## 5. Domain model and invariants

| Entity | Important fields and rules |
|---|---|
| User / auth tables | Better Auth identities, sessions, verification/reset tokens |
| Organization / membership | Organization ID, timezone, role, membership status |
| Organization policy | Versioned automation, routing and escalation configuration |
| Volunteer profile | Organization membership, external identity aliases, active status |
| Beneficiary reference | Minimal organization-local identifier and aliases; no global person matching |
| Source message | Organization, channel, source identity, author, event/receipt times, raw text, revision |
| Attachment | Organization, source message, private storage key, digest, MIME, size |
| Import batch | Parser, date format, timezone, mapping decisions, status and row errors |
| Extraction run | Source revision, prompt/schema/model versions, result, validation failures, cost/usage |
| Proposal / evidence link | Proposed entity or amendment, field evidence, ambiguities, resolution |
| Activity | Organization, date/time precision, kind, beneficiary reference, lifecycle |
| Contribution | Activity, volunteer, integer duration minutes or unknown, approval status |
| Need | Category, urgency, owner, status, deadlines, originating evidence |
| Review decision | Actor, entity revision, decision, edits/reason, timestamps |
| Notification / attempt | Channel, recipient, event key, attempt, provider acceptance/failure status |
| Outbox / audit event | Tenant, aggregate, event version, actor/system provenance, correlation ID |
| Telegram link | Telegram identity, app user, allowed memberships, selected organization |

Invariants:

- Every tenant-owned row includes organization_id. Composite keys/foreign keys prevent cross-organization relationships. Every server operation checks membership and role; client-supplied organization IDs are never authorization.
- Tenant-aware repository APIs require organization context. Jobs carry organization IDs and revalidate membership where user authority matters. Test all indirect access paths, attachments, exports, search, and callbacks.
- One activity can have several volunteer contributions. Two people at a one-hour visit produce one visit and two volunteer-hours. One person repeating the same contribution does not add hours.
- Approved contributions are the reporting ledger. Pending, rejected, missing-duration and superseded records remain visible but do not inflate totals.
- Duration uses integer minutes. Unknown duration is not zero. Dates preserve source timezone and precision; uncertain dates enter review.
- Source evidence is retained with explicit revisions. Corrections amend approved records transactionally and preserve history. Concurrent reviews use optimistic version checks.
- A photo alone does not establish a person's identity or volunteer hours. Face recognition is excluded.
- Urgent inferred needs may create clearly labeled provisional alerts before approval. They remain distinguishable from verified records and can be withdrawn with an audit trail.

## 6. Intake, extraction, and deduplication

### Intake normalization

Normalize channel payloads into a versioned SourceEnvelope with tenant, channel identity, author mapping, message timestamp, receipt timestamp, text, attachment references, and reply/edit relationships. Preserve the original. Return a durable receipt once persisted; show processing state and retry errors.

Web submissions use client-generated idempotency keys. Telegram uses deployment/bot identity plus update_id for ingestion deduplication and chat/message IDs for message identity; edited messages produce revisions. Imports track batch and per-message fingerprints. Cross-import matching must not silently discard two distinct but identical-looking messages: ambiguous collisions enter review.

Initial imports support a documented WhatsApp text-export subset with optional separately uploaded photos and a normalized CSV/JSON template. Show preview, locale/date-format selection, timezone, author mapping and unresolved attachments before committing. Unsupported lines get visible errors. Do not promise arbitrary export compatibility.

### AI pipeline

1. Load bounded tenant-authorized source context and relevant reply chain.
2. Extract schema-validated activities, contribution candidates, needs, corrections and unresolved fields, with quoted spans or attachment references.
3. Validate dates, membership, duration, references, routing and required fields with code.
4. Find deterministic candidate matches within the organization by participant, date, activity and source references.
5. Use a bounded AI comparison only for ambiguous candidate pairs; emit evidence and a proposed link, not an uncontrolled merge.
6. Apply organization policy, creating reviews or eligible records through domain services.
7. Persist outcomes and emit assignment/notification events through the outbox.

Model output is untrusted input. Source messages cannot grant permissions, override routing policy, request secrets, or execute tools. No arbitrary URL fetching from messages. Limit context, photo size, batch size, retries, timeouts and per-organization model spend. Low-detail images or incomplete text produce explicit unknown fields.

### Automation policies

Review-all: all activity/contribution records and nonurgent needs require approval. Urgent provisional needs notify the coordinator immediately.

Validated-auto-record: automatically approve only complete explicit new entries with resolved authors, required fields, no conflicts and no plausible duplicate. All merges, ambiguous identity links, conflicting corrections and sensitive decisions require staff review. New need routing follows configured deterministic rules. Do not use a model's confidence number as the only gate.

Policy changes affect future processing; existing queued proposals preserve their processing policy version until explicitly reprocessed. Reprocessing creates a new run and does not create additional ledger entries.

## 7. Notifications and routing

Map need categories to primary staff, fallback coordinator, urgency and acknowledgment deadline. An unrecognized category routes to the coordinator. Organization timezone defines same-day due times. Urgent needs notify immediately, without quiet-hour deferral, under the organization's configured policy.

In-app is the authoritative task view. Telegram/email carry minimal details and an authenticated deep link. Account recovery/invitations use separate auth email templates. Volunteers cannot acknowledge staff assignments unless permitted. Telegram actions resolve against current membership and a scoped action token; replay or stale actions cannot repeat transitions.

Retry transient delivery failures with capped backoff. Record provider rejection, accepted delivery, acknowledgment, and resolution separately. An ambiguous provider timeout may produce repeated external messages; domain actions remain idempotent. Stop further reminders after resolution or cancellation. A scheduler queries due work from persisted deadlines so worker downtime does not lose escalation.

Local/demo delivery uses Mailpit and a Telegram test adapter or explicitly configured live bot. Tests never send messages to real recipients. Live credentials are enabled only by environment configuration.

## 8. Phases, milestones and acceptance gates

### Phase 0 — Contracts and engineering foundation

Deliver: root Bun workspace, Node 26 pinning, TypeScript strict configuration, Biome, Vitest, Compose skeleton, CI, MIT license, environment schema, architecture decisions, synthetic benchmark manifest, shared schemas, API/error/event contracts and task ownership map. Select and lock compatible library versions. Add scripts for install, dev, build, typecheck, check, test, migrations and seeding.

Milestone M0: clean checkout installs reproducibly; quality/build checks run under Node 26; web/worker/database start; shared contracts are approved and fixture expected results are explicit.

Parallel work after initial contracts: infrastructure and fixture construction can proceed separately. Do not let multiple agents independently redefine shared entities.

### Phase 1 — Identity, tenancy and domain persistence

Deliver: Better Auth integration, sign-in/out, password reset, invitations, organization switcher, role checks, Drizzle schema/migrations, tenant repositories, audit helpers, core activity/contribution/need services, account/organization seeds. Seed Tidepath and a second fictional nonprofit to exercise isolation. Demo credentials only in an explicit demo profile; ordinary production seed does not create known-password accounts.

Milestone M1: owner, coordinator, volunteer and report-reader demo accounts work; a multi-membership user can switch organizations; cross-tenant reads/writes/attachments are denied; core domain transitions persist correctly.

### Phase 2 — First end-to-end web workflow

Deliver: mobile text submission; source inbox; extraction adapter and worker; review screen with original evidence; accept/edit/reject actions; contribution ledger; need assignment and acknowledgment; in-app alerts; initial totals.

Milestone M2: five fixed fictional messages produce expected records, including one shared visit, one uncertain duration and one urgent need. Staff can review the result, count hours accurately and acknowledge the need. Refresh and worker restart preserve state. Run one real OpenAI extraction smoke check; mocked extraction alone does not satisfy this gate.

This is the earliest usable product and the first integration checkpoint.

### Phase 3 — Complete intake channels

Deliver in parallel: import parser/preview with author and attachment mapping; private photo upload and extraction; Telegram account linking, selected-organization flow, webhook normalization, text/photo intake and receipts. Production webhook uses HTTPS and secret verification. Development supports long polling or documented replay fixtures, with only one transport enabled per bot.

Milestone M3: equivalent web, imported and Telegram updates reach the same domain pipeline. Unlinked users and ambiguous organization context cannot create records. Repeated updates/imports do not inflate totals. Unsupported imports and missing files show actionable errors.

### Phase 4 — Reconciliation and configurable automation

Deliver: match candidates, staff linking/merge decisions, duplicate contribution prevention, corrections/revisions, English/Spanish fixtures, policy configuration, optimistic review concurrency, safe reprocessing and provisional urgent alerts.

Milestone M4: the adversarial week passes expected totals; repeated imports and worker retries leave totals stable; shared visits preserve both volunteers' hours; a 60-to-90-minute correction changes the existing contribution; two reviewers cannot apply conflicting decisions; every approved field has evidence or a staff-entered reason.

### Phase 5 — Delivery and follow-through

Deliver: routing settings, SMTP email adapter and templates, Telegram outbound messages, notification outbox, delivery attempts, acknowledgment links/actions, deadline scheduler, escalation, fallback staff and failure dashboard.

Milestone M5: urgent need routes immediately; staff acknowledgment stops acknowledgment reminders; simulated elapsed time triggers escalation once per level; delivery failures are visible; process restart does not lose overdue work; every action respects current role and tenant. Use a controlled clock in tests and a demo-only clock override, never arbitrary clock control in production.

### Phase 6 — Reporting and operational experience

Deliver: date/program/volunteer filters, approved minutes/hours, unique visits, open/resolved needs, response/acknowledgment times, pending exclusions, CSV export, authorized evidence drill-down, mobile/accessibility polish, organization settings and member administration.

Milestone M6: seeded weekly report exactly matches the independently authored expected totals. Changing an approved record updates totals consistently. Board readers see aggregates without private evidence. Volunteer sees only permitted records. Export and UI use identical domain reporting definitions and timezone boundaries.

### Phase 7 — Hardening, deployment and submission

Deliver: complete Compose production profile, reverse-proxy TLS configuration, one-shot migration job, health/readiness endpoints, graceful worker shutdown, persistent volumes, backup/restore scripts, structured logs and metrics, runbooks, dependency/secret scan, failure/recovery tests, README and scripted demo.

Milestone M7: fresh-host installation and restore rehearsal succeed; full synthetic week runs through configured channels; restart/retry tests preserve data; no credentials or real people appear in the repository; public repository and MIT license are verified; setup and demo are reproducible.

Production-capable baseline means single-host operational readiness with documented limits. It does not imply high availability or certification for sensitive case records.

## 9. Parallel-agent execution plan

Use a coordinator/integrator and up to five implementation agents. Start with four active sessions: A coordinator plus B identity/domain, D extraction/evals and E UI foundation. Keep C/F as standby lanes initially; rotate them in as tasks become unblocked or a lane completes. Revisit concurrency after two accepted slices based on review backlog, rework and blocked time. The harness-neutral operating kit, six startup prompts, local board and recovery protocol are in `docs/agents/README.md` (ADR 0004). This setup does not launch agents or implement later phases; dispatch uses explicit task assignments. Smaller teams combine lanes sequentially rather than changing contracts.

| Agent lane | Owned areas | Primary deliverables | Dependencies |
|---|---|---|---|
| A — Coordinator/platform | Root configuration, CI, infra, contracts, integration | M0, integration branch, releases | None |
| B — Data/auth/domain | db, core domain, auth server configuration | M1, ledger invariants, tenant authorization | M0 contracts |
| C — Intake/integrations | intake package, intake endpoints and source adapters | Imports, photos, Telegram inbound | SourceEnvelope, tenant/auth interfaces |
| D — AI/reconciliation | ai package and reconciliation domain module | Extraction, validation, matching proposals, evals | Shared schemas, candidate repository contracts |
| E — Product UI | UI routes/components; domain query clients | Volunteer intake, inbox/review, needs, reports | Contract stubs initially; M1/M2 services later |
| F — Notifications/quality | notifications, worker delivery handlers, acceptance suites | SMTP/Telegram outbound, escalation, cross-cutting verification | Event contracts; M1 need services |

Worker entrypoint ownership stays with A; each lane exports handlers from owned modules. B owns migration generation and ordering. A owns contracts, package manifests, lockfile and shared config; other agents request dependency changes. C owns Telegram inbound and identity mapping; F owns outbound delivery and callbacks with a jointly frozen callback contract. E owns page composition; B owns auth business logic. This avoids overlapping edits.

### Execution waves

- Wave 0: A establishes contracts/repo; B defines schema proposal; D/F author expected-result fixtures and failure scenarios. Contract review closes M0.
- Wave 1: B builds identity/domain; C builds intake normalization against stubs; D builds extraction/evals; E builds UI against contract fixtures; F builds transport adapters and test harness. A integrates continuously.
- Wave 2: B/D/E complete M2 first. C adds channels against the proven pipeline. F connects notifications. A runs integration gates.
- Wave 3: B/D complete reconciliation; C verifies edits/reimports; E completes review/configuration; F verifies retries/escalation. Close M3–M5.
- Wave 4: E/B finish reports; C/D finish mixed-channel acceptance; F leads recovery/security checks; A closes deployment and submission.

Critical path: contracts → tenant/domain foundation → first reviewed extraction → reconciliation → validated reports → release. Intake adapters and notification delivery can develop in parallel, but cannot replace the M2 integration gate.

### Agent task contract and merge rules

Each task states goal, allowed paths, frozen input/output types, prerequisites, fixtures, acceptance commands and handoff notes. Each agent works in an isolated branch/worktree. Merge small completed slices, not one large final merge. Every handoff lists changed interfaces, migrations, tests, environment variables and unresolved issues.

Shared contract changes are proposed to A before implementation. A lands the change and updates consumers. B alone lands generated migrations. Never run parallel destructive migration/reset commands against a shared development database; use per-worktree/test databases. Run fixture-only CI without network secrets; live integration checks are opt-in. Integration review includes tenant context, idempotency, authorization and evidence provenance.

Illustrative task IDs: P0-01 workspace; P0-02 contracts; P0-03 benchmark; P1-01 auth/tenancy; P1-02 domain/ledger; P2-01 extraction worker; P2-02 review UI; P2-03 first workflow; P3-01 imports; P3-02 photos; P3-03 Telegram; P4-01 matching/corrections; P4-02 policies; P5-01 delivery; P5-02 escalation; P6-01 reports; P7-01 deployment; P7-02 acceptance/submission. Split these into reviewable sub-tasks after M0.

## 10. Testing and acceptance matrix

Vitest unit tests cover meaningful domain rules, deterministic routing, parser edge cases, duration/timezone handling, policy gates and correction calculations. PostgreSQL integration tests cover unique constraints, transactions, concurrent approvals, job replay and tenant isolation. Small Playwright smoke tests cover sign-in, organization switch, submit/review/acknowledge and report access. AI evaluation uses fixed expected facts and errors, not exact wording. Separate deterministic provider stubs from opt-in live model checks.

| Scenario | Required result |
|---|---|
| Identical webhook replay | One source effect; no added hours/needs |
| Same export imported twice | No inflated ledger; ambiguous collisions reviewed |
| Two volunteers, one 60-minute visit | One visit, 120 volunteer-minutes |
| Same volunteer repeats visit report | One contribution after reconciliation |
| Duration corrected from 60 to 90 | One contribution of 90; previous revision retained |
| Missing duration | Unknown/pending; not silently zero or inferred |
| Spanish supply request | Correct category and evidence preserved |
| Photo with no text | Visible observations only; no invented identity/time |
| Uncertain urgent request | Provisional staff alert; no claim of verified facts |
| Worker crashes after record commit | Replay does not duplicate business effects |
| Staff resolves need before reminder runs | No new valid reminder for resolved state |
| Provider times out | Attempt remains inspectable; safe retry semantics documented |
| Tenant ID or attachment ID manipulated | Denied; no existence/details leaked |
| Membership removed before bot callback | Action denied |
| Model unavailable or schema invalid | Source retained; bounded retry/review; no silent loss |
| Source includes malicious instructions | No tool execution or policy override |
| Two staff approve concurrently | One version wins; other sees conflict |
| Report across local midnight | Correct organization-timezone inclusion |

Benchmark: at least 25–30 synthetic updates, multiple volunteers, two organizations, several photos and a separate expected-results manifest. Every deliberate urgent fixture must appear in the staff queue; every approved total must match the manual oracle. Review-all and validated-auto-record each run through acceptance. Track extraction error categories, processing latency and review burden; do not claim accuracy from a tiny demo dataset.

## 11. Operations, configuration and boundaries

Compose services: reverse proxy, web, worker, PostgreSQL, one-shot migration job; Mailpit in development/demo. Persistent database and attachment volumes. Only reverse proxy is publicly exposed. Startup waits for successful migrations and database health. Web and worker use least-privilege credentials where feasible; migration credentials remain separate.

Environment groups: database/auth URLs and secrets; OpenAI API key/model/budget; Telegram bot token/webhook secret; SMTP host/port/TLS/credentials/from address; attachment root/limits; public app URL; demo mode; log level. Commit examples with placeholders. Keep secrets out of job payloads, source fixtures and logs.

Operational signals: queue depth/oldest-job age, processing failures, model usage/cost, unresolved urgent needs, overdue acknowledgments, notification failures, disk space, database health and backup age. Use correlation IDs without logging raw family messages. Back up database plus files consistently and rehearse restoration. Policy-controlled retention/deletion must remove attachment bytes and derived AI data while preserving minimal permitted audit records; define retention settings before any real deployment.

Single-host limitations: host failure causes downtime; backups are essential; local storage is not horizontally scalable. Telegram webhook requires public HTTPS; local execution uses polling or replay. Email SMTP and Telegram credentials remain external setup requirements. Demo seed and clock override must be disabled in ordinary production mode.

## 12. Release cuts and estimating

No calendar deadline or staffing budget was supplied. Sequence by acceptance gates, not invented dates. Parallel agents accelerate independent modules; integration, schema ownership and test review remain serial bottlenecks. Estimate each lane after M0 and revise after M2 demonstrates actual integration throughput.

| Release cut | Included milestones | Purpose |
|---|---|---|
| First working slice | M0–M2 | Prove the core workflow |
| Hackathon complete | M0–M7 with narrow documented import formats | Complete agreed scope and reproducible demo |
| Later expansion | Object storage, additional channels, UI localization, advanced scheduling | Separate future scope |

If deadline pressure develops, preserve ledger correctness, tenant isolation, urgent need ownership and evidence. Reduce supported import variants, advanced filters, UI customization and nonessential notification templates first. Do not label an incomplete Telegram/email integration as complete; use clearly named demo adapters where live credentials are absent.

## 13. Final definition of done

- Node 26 runtime, Bun dependency workflow, Biome and Vitest are enforced; no ESLint/Prettier configuration.
- Staff and volunteers authenticate; demo identities are seeded only in demo mode.
- Two organizations demonstrate isolated data and configurable policies.
- Web, supported file imports and Telegram text/photo updates reach the same pipeline.
- Duplicate imports/retries cannot inflate approved totals; shared visits preserve legitimate hours.
- Corrections and ambiguous matches are reviewable with evidence and audit history.
- Urgent needs route immediately, require human acknowledgment and escalate when overdue.
- In-app, SMTP and Telegram adapters work with documented live configuration and safe demo transports.
- Report totals match the synthetic oracle and exclude pending entries explicitly.
- Compose installation, restart and backup restoration are demonstrated.
- Public repository, MIT license, README, synthetic fixtures and a repeatable demo are present.

## 14. Primary implementation references

Consult current official docs and pin exact versions at phase 0:

- Node.js 26 release: https://nodejs.org/en/blog/release/v26.0.0
- Better Auth organization support: https://better-auth.com/docs/plugins/organization
- Better Auth Drizzle adapter: https://better-auth.com/docs/adapters/drizzle
- PostgreSQL job queue: https://github.com/timgit/pg-boss
- Telegram Bot API: https://core.telegram.org/bots/api

These references support integration choices; acceptance gates still require testing the selected versions together.
