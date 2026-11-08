# Product acceptance integration

Runs against a dedicated PostgreSQL database whose name ends in `_test`; the harness truncates its tables. Never point it at a shared database. Example, after provisioning an isolated instance on port 55482:

```sh
TEST_DATABASE_URL=postgres://relay:relay@127.0.0.1:55482/relay_acceptance_test node node_modules/vitest/vitest.mjs run --config tests/integration/product-acceptance/vitest.config.ts
```

The first five canonical synthetic sources are persisted, extracted, and reviewed through the real database and product HTTP boundary. Sources 02–04 are deliberately rejected: the current product has no explicit cross-source activity-link workflow to resolve the duplicate and correction candidates. Consequently this suite does **not** claim the first-five oracle totals or evidence-link provenance. The local-midnight report setting also awaits the organization timezone integration. These remain acceptance gates; do not treat the passing partial workflow as completion of the oracle.

The resolver in this test selects synthetic identities from a test-only header and calls real membership authorization. It does not exercise session authentication. The photo uses a private temporary filesystem and synthetic pixels; no provider or external recipient is contacted.
