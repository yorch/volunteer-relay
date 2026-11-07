# PostgreSQL integration verification

Root Vitest/verify remains database-free. Auth/tenant and source/outbox PostgreSQL suites are selected explicitly by `bun run test:integration` or:

```sh
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config packages/db/vitest.integration.config.ts
```

Set DATABASE_URL for development migration/seed operations and a distinct TEST_DATABASE_URL whose database name ends in `_test`. The suite applies migrations and truncates only its test database auth tables. Never point it at another worktree's resources, a shared database or a production server. See docs/agents/BOOTSTRAP.md for creating private development/test databases. CI uses a dedicated PostgreSQL service job; the ordinary quality job has no database dependency.

Coverage includes tenant-scoped membership lookups, multi-membership roles, revocation/live role changes, constraints, idempotent no-password synthetic seeds and real Better Auth session/organization/role permissions. This is not full M1 UI/reset/invitation/audit acceptance and does not cover future ledger/proposal/queue effects. Source coverage includes tenant-scoped source/revision/attachment/author/outbox constraints, exact-envelope/idempotency replay, concurrency/rollback, sequential edits, membership removal with preserved evidence, safe failures, and an applied-FK catalog guard for column-specific SET NULL. Tests are serial within a private test database; normal application evidence has no delete/update port.
