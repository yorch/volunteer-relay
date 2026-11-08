# P1-12 auth HTTP checks

Run under Node 26.11.1 from the task checkout. Root verification does not select this suite.

```sh
# Controlled inputs, headers, status mapping and privacy; no database or server.
node node_modules/vitest/vitest.mjs run --config tests/integration/http-auth/vitest.config.ts tests/integration/http-auth/handlers.test.ts

# Build first. Required separate private database: 127.0.0.1:55465/relay_b_p1_12_test.
# The suite migrates and truncates only the verified test database.
# It refuses an occupied port3186, starts its own production Next process,
# uses synthetic accounts and stops that process after the suite.
bun run verify
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config tests/integration/http-auth/vitest.config.ts

# Run separately/serially: these suites share the private test database.
node --env-file=.env.local node_modules/vitest/vitest.mjs run --config packages/db/vitest.integration.config.ts
```

The production composition has no mail transport and returns uniform unavailable errors for public mail requests. The controlled suite checks helper invocation and fixed destinations; the existing auth suite owns token/mail lifecycle behavior. No live provider, SMTP or real account is used.
