# Product demo seed acceptance

Run with a dedicated disposable PostgreSQL database whose name ends in `_test` and differs from `DATABASE_URL`:

```sh
TEST_DATABASE_URL=postgres://relay:relay@127.0.0.1:55482/relay_rich_demo_test node node_modules/vitest/vitest.mjs run --config tests/integration/demo-seed/vitest.config.ts
```

This suite resets its test database and uses a temporary private attachment root. Never point it at shared or production data. It uses synthetic demo identities and controlled providers; it does not send mail, call a model or deliver notifications.

The independently stated acceptance target is Tidepath: two activities with approved contributions, three approved contributions totaling 180 minutes, and one pending contribution with unknown duration; Harbor: zero approved minutes. The demo should expose new, assigned, acknowledged and resolved needs, including a provisional urgent need; review candidates should cover a shared visit, duplicate, correction, Spanish text, unknown time and a photo. The photo must be readable only under the relevant tenant and authority. Exact application records and proposal evidence must remain internally consistent.

The setup is deliberately opt-in and reruns must preserve edits rather than resetting the walkthrough. Missing/partial or conflicting fixture state must fail without overwriting existing data; production and missing explicit demo authorization must be refused.
