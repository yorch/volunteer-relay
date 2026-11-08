# ADR 0010: PostgreSQL work records and transactional outbox

Status: accepted for the current single-host product implementation. This decision supersedes the implementation plan's original pg-boss planning default; it does not change the delivery guarantees required by the plan.

## Context

The product already persists source revisions and domain events in PostgreSQL. It needs durable extraction, delivery and maintenance work across process restarts, without a gap between recording a source or domain change and recording work that follows it. Provider calls and notification delivery can fail or be repeated, and workers must not let an expired claim complete over a newer claim.

## Decision

Use the existing PostgreSQL source and outbox records together with product-owned work tables and scheduling queries instead of adding pg-boss. Source evidence and its outbox event are persisted transactionally. Workers claim eligible work using database locking and time-bounded lease tokens; completion and failure paths check the active token. Retry timing, bounded attempts and explicit staff retry/reprocessing are persisted. Domain operations use scoped idempotency keys and constraints; scheduled routing and delivery state remain durable in PostgreSQL. This keeps the queue, evidence and business transaction in the same operational datastore and avoids adding another queue abstraction for the current deployment.

## Consequences

Processing is at least once: a lease may expire, a process may restart, or an external call may succeed before its result is recorded. Handlers and effects must tolerate replay. A provider accepting a request is not proof of human acknowledgment, and external delivery is not exactly once. The application owns lease expiry, retry scheduling, monitoring and maintenance that a queue library might otherwise provide; operators must monitor failures, queue age and storage. The implementation is optimized for the documented single-host profile, and future scale or operational requirements may justify reconsidering a dedicated queue. Integration tests and controlled recovery checks exercise these behaviors, but they do not certify a live external provider.
