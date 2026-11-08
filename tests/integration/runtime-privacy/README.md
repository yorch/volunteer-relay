# Runtime privacy integration

Run `TEST_DATABASE_URL=... node node_modules/vitest/vitest.mjs run --config tests/integration/runtime-privacy/vitest.config.ts` with a private PostgreSQL database ending in `_test`, different from `DATABASE_URL`. This test resets that database and creates a temporary private blob directory; never use a shared database or real evidence.

The test writes synthetic image bytes through the private blob store, records and approves a synthetic contribution, redacts the expired source, executes the real filesystem eraser and exports the deployment ledger using the CLI. It rebuilds the older source and ledger state in the isolated database, verifies a tampered signed ledger is rejected, and restores the authentic signed ledger. The rebuilt state models an older snapshot; this test does not exercise PostgreSQL backup tooling.
