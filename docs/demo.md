# Demo guidance

Use a separate development environment and synthetic data only. The development Compose profile and demo tooling are distinct from the production profile; `DEMO_MODE=true` is deliberately rejected in production. Never seed demo records into a live organization, copy real source evidence into a demo, or enable real notifications for a demonstration.

For a private walkthrough, start the development stack using the repository's setup instructions and local Mailpit. Model extraction is disabled unless an external provider and its budget and pricing are configured; the deterministic fixture provider is used by tests. Verify the selected organization and role before demonstrating intake, inbox review, needs and reports. Explain that unknown duration and date remain unknown, that pending contributions do not count as approved time, and that a delivery attempt is not human acknowledgment. Review the inbox's original evidence and preserve possible duplicate imports for staff review.

For a production-profile rehearsal, use a unique isolated Compose project, throwaway credentials, separate volumes and a non-public host; do not point Caddy at the live domain or enable real providers. Follow [operations.md](operations.md) for migrations, stopping writers, backups and restore. The synthetic database-and-attachment recovery rehearsal does not prove a fresh-host TLS deployment or real provider operation.

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
