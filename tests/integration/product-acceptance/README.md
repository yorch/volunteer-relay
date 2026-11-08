# Product acceptance integration

Runs against a dedicated PostgreSQL database whose name ends in `_test`; the harness truncates its tables. Never point it at a shared database. Example, after provisioning an isolated instance on port 55482:

```sh
TEST_DATABASE_URL=postgres://relay:relay@127.0.0.1:55482/relay_acceptance_test node node_modules/vitest/vitest.mjs run --config tests/integration/product-acceptance/vitest.config.ts
```

The first five canonical synthetic sources are persisted, extracted, and reviewed through the real database and product HTTP boundary. Explicit staff links and a reasoned correction produce one shared visit, Mira 90 minutes and Sol 60 minutes, with unknown duration left pending. Additional cases cover urgent needs, a New York local-midnight report boundary, import rollback, private photos, and a revised source. JSON and CSV report projections are compared at the date boundary.

Most workflow tests select synthetic identities through a test-only header and use live membership authorization. A separate product-handler test exercises a real Better Auth session and session resolver, including denial after membership removal. It uses an in-process HTTP handler, not a running web server. The photo uses a private temporary filesystem and synthetic pixels; no provider or external recipient is contacted.

The complete checked-in fictional week contains 28 sources (the independent manifest also lists 28), not 30. The week test runs it twice against PostgreSQL, once under each automation setting; uncertain records receive explicit staff decisions and both runs must match the independent tenant totals. Repeated intake, review, and eligible automatic decisions are replayed. Attachment-only fixture proposals have no inferred activity or contribution; this does not exercise a vision model.
