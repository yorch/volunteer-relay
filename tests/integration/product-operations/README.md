# Operations integration tests

Run against the isolated PostgreSQL database assigned to this suite. Setup truncates the test database through the shared domain fixture; never point it at another database.

```sh
TEST_DATABASE_URL=postgres://relay:relay@127.0.0.1:55482/relay_operations_test node node_modules/vitest/vitest.mjs run --config tests/integration/product-operations/vitest.config.ts
```

The operations endpoint reads the latest 100 audit or delivery entries. Audit `before` is a timestamp filter, not a lossless pagination cursor when timestamps coincide. Delivery acceptance represents provider acceptance only. Model totals are organization-scoped across stored windows; open sent/reserved amounts remain reserved until settled.
