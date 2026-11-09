# Auth HTTP checks

Run under Node 26.11.1. Root `bun run test` does not select this suite; CI runs
it in the `postgres-integration` job after the product integration suites.

```sh
# Whole suite (what CI runs). Needs TEST_DATABASE_URL and a production build.
bun run build
bun run test:http-auth:integration

# Database-free files only: controlled inputs, headers, status mapping, privacy.
node node_modules/vitest/vitest.mjs run --config tests/integration/http-auth/vitest.config.ts \
  tests/integration/http-auth/handlers.test.ts tests/integration/http-auth/auth-hardening.test.ts
```

| File                                                                                                                                           | Needs                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `handlers.test.ts`, `auth-hardening.test.ts`                                                                                                   | nothing: controlled synthetic adapters                                                           |
| `last-organization-repository.test.ts`, `last-organization-sign-in.test.ts`, `pending-invitations.test.ts`, `invitation-accept-errors.test.ts` | `TEST_DATABASE_URL`: real Better Auth in process, no server                                      |
| `local-http.test.ts`                                                                                                                           | `TEST_DATABASE_URL` and a production build (`apps/web/.next/BUILD_ID`, or `RELAY_NEXT_DIST_DIR`) |

Environment:

- `TEST_DATABASE_URL` (required by the DB-backed files): a private database
  whose name ends in `_test` and that differs from `DATABASE_URL`, the same
  guard as every DB-backed suite (`tests/integration/auth/support.ts`). The
  suites migrate it and truncate only its auth tables. Files share it, so the
  config runs them serially; do not run another suite against it concurrently.
- `HTTP_AUTH_TEST_PORT` (optional, default `3186`): the port for the private
  `next start` that `local-http.test.ts` spawns. An occupied port is refused,
  never reused. Choose a free one when another checkout uses 3186.
- `BETTER_AUTH_SECRET` (optional): passed to that server; a synthetic secret
  is used when unset.

`local-http.test.ts` starts the production composition, which includes the SMTP
transport (`apps/web/lib/mail/production.ts`). It aims SMTP at a closed local
port, so delivery fails and the suite checks that the failure stays invisible:
reset and verification requests for known and unknown accounts get the same
accepted response. It uses synthetic accounts and stops the server after the
suite. No live provider, SMTP server or real account is used.
