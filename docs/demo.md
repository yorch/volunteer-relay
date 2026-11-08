# Demo guidance

Use a separate development environment and synthetic data only. The development Compose profile and demo tooling are distinct from the production profile; `DEMO_MODE=true` is deliberately rejected in production. Never seed demo records into a live organization, copy real source evidence into a demo, or enable real notifications for a demonstration.

For a private walkthrough, start the development stack using the repository's setup instructions and local Mailpit. Model extraction is disabled unless an external provider and its budget and pricing are configured; the deterministic fixture provider is used by tests. Verify the selected organization and role before demonstrating intake, inbox review, needs and reports. Explain that unknown duration and date remain unknown, that pending contributions do not count as approved time, and that a delivery attempt is not human acknowledgment. Review the inbox's original evidence and preserve possible duplicate imports for staff review.

For a production-profile rehearsal, use a unique isolated Compose project, throwaway credentials, separate volumes and a non-public host; do not point the production domain at the rehearsal or enable real providers. Follow [operations.md](operations.md) for migrations, stopping writers, backups and restore. The synthetic database-and-attachment recovery rehearsal does not prove a fresh-host TLS deployment or real provider operation.

## Synthetic accounts

After the [local setup](../README.md) has applied migrations, provision demo identities only in a private development database:

```sh
DEMO_MODE=true NODE_ENV=development node --env-file=.env.local apps/web/lib/auth/demo-cli.ts --demo
```

This explicitly creates or safely reuses fictional verified identities and refuses conflicting records. The public synthetic emails are `demo-{owner,coordinator,volunteer,reader,multi}@example.invalid`; their intentionally public demo-only password is defined in [demo.ts](../apps/web/lib/auth/demo.ts). Never use these credentials for real accounts. Demo account provisioning does not populate the product acceptance fixtures or send email.

## Repeatable product acceptance

The integration runner mutates and truncates its test database. Start a separate local PostgreSQL instance or use the local Compose PostgreSQL service from the README, and create a **new, dedicated** database; choose a different name if the example already exists. Never point this command at the development, shared or production database. With the default local Compose port and credentials:

```sh
docker compose exec -T postgres createdb -U relay relay_product_test
TEST_DATABASE_URL=postgres://relay:relay@127.0.0.1:5432/relay_product_test bun run test:product:integration
```

Adjust the host port and database name for your isolated instance; the database name must end in `_test`. The product acceptance harness processes the 28 fictional source updates under both review-all and validated-auto-record policies and checks the independently authored oracle: Tidepath has 300 approved minutes and Harbor has 150. These tests use controlled adapters and synthetic evidence; they do not invoke real model, Telegram or SMTP providers. Test databases and volumes should be handled according to your local cleanup policy; never reset a database you did not create for the test.

## Rich product walkthrough

The rich seed command provisions the same synthetic accounts and adds a versioned product dataset. It is separate from ordinary `db:seed`, which remains credential-free. Use a private, migrated development/test database and a private writable `ATTACHMENT_ROOT`. Supply both explicitly; never reuse a production database.

```sh
DEMO_MODE=true NODE_ENV=development node --env-file=.env.local scripts/seed-demo.ts --demo
```

If variables are already exported, the equivalent command is `DEMO_MODE=true NODE_ENV=development bun run db:seed:demo`. The seed refuses ordinary or production invocation before connecting to PostgreSQL. It makes no model, SMTP or Telegram calls. Proposals and delivery examples are deliberately authored fixtures, not provider output or real deliveries.

The account step and product step each use their own transaction. If product setup fails, the verified synthetic accounts may already exist; repair the reported configuration/collision and retry. There is no automatic purge/reset. A complete same-version rerun reuses the initial product data and preserves subsequent review decisions, assignments and corrections; it does not restore the starting demo. Changed identities, partial profiles and reserved-name collisions are refused. Use a newly created private database and fresh attachment directory for a clean repeat presentation.

Sign in with a synthetic role at `/sign-in`, choose Tidepath in `/account`, then open `/workspace`. Accounts use the intentionally public demo-only password `Public-Synthetic-Demo-Only-2026!`:

| Account                            | Demo role                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `demo-owner@example.invalid`       | Organization administration, settings, operations and all staff workflows |
| `demo-coordinator@example.invalid` | Source review, activities, needs and reports                              |
| `demo-volunteer@example.invalid`   | Own updates, receipts and private evidence only                           |
| `demo-reader@example.invalid`      | Aggregate reports without private source evidence                         |
| `demo-multi@example.invalid`       | Tidepath owner and Harbor report-reader, for organization/role switching  |

The public credentials belong only to this explicit fixture profile. Keep the demo private and do not use this password for other accounts.

### Suggested ten-minute walkthrough

The starting dataset uses the fictional week November 2–8, 2026. The manually specified [starting oracle](../fixtures/demo/expected-start.json) is separate from the 28-source acceptance benchmark. Tidepath starts with ten sources, seven review cases, three approved contributions across two activities totaling **180 minutes / 3 hours**, one pending unknown-duration contribution, and five needs. Harbor has one separate unreviewed source and zero approved minutes.

1. Sign in as coordinator and open Source inbox. Inspect the original text and proposed fields for the shared visit, possible duplicate, 60-to-90-minute correction, Spanish update, unknown duration, photo and urgent need. These are explicitly authored fixture proposals. Review decisions are real persisted application actions.
2. Open Activities and Summary. Explain that two people contributing 60 minutes to one activity count as two contributions and 120 minutes. A separate 60-minute supply contribution makes the initial 180-minute total; unknown duration remains pending and excluded.
3. Inspect the labeled synthetic supplies image. It establishes neither a person's identity nor their hours. Accepting a photo must not invent either.
4. Open Needs. Compare new/unassigned, assigned, acknowledged, resolved and urgent provisional examples. Assign and acknowledge using the correct staff identity; delivery provider acceptance is separate from acknowledgment. Initial deadlines are unset so merely starting a worker cannot expire the fixed-date examples.
5. Open Notifications and Delivery as owner/coordinator. The displayed failed email attempt is a terminal synthetic example, with no real provider acceptance or pending external delivery. External notification preferences remain off.
6. Open Import and use the [JSON/CSV samples and author map](../fixtures/demo/README.md). Preview, confirm, then replay the same unchanged input. With no external extraction configured, new imports stay queued; they do not magically acquire fixture proposals.
7. Sign in as volunteer in a separate browser context to show own updates and receipts. Sign in as report-reader to show aggregate reporting without private source evidence. Finally use the multi-organization account to switch from Tidepath owner to Harbor report-reader and demonstrate the separate zero-minute report.

Actions change the demo. Rerunning the seed preserves those changes, including adjusted report totals. For the exact starting presentation again, create a new isolated database and attachment directory, migrate it, and seed it; do not run destructive resets against an existing database.

### Verification

Eight private PostgreSQL acceptance cases cover fresh composed CLI setup, reruns, edited-record preservation, role/tenant evidence boundaries, report totals, all seven review scenarios, need states, private 720×480 PNG bytes, partial/collision refusal and production/default invocation refusal. The seed inserts no unconsumed outbox or model-processing work and no dispatchable external delivery. See [demo-seed acceptance](../tests/integration/demo-seed/README.md). It is part of `bun run test:product:integration`; it uses a disposable `_test` database and never substitutes for live-provider acceptance.
