# Integration boundary

No product integration tests are implemented in Phase 0. CI's Compose job verifies infrastructure startup and PostgreSQL connectivity. Task owners add PostgreSQL-backed suites here with dedicated databases and an explicit command; root Vitest currently selects only package/fixture unit tests. Never reset a shared database.
