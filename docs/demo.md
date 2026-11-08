# Demo guidance

Use a separate development environment and synthetic data only. The development Compose profile and demo tooling are distinct from the production profile; `DEMO_MODE=true` is deliberately rejected in production. Never seed demo records into a live organization, copy real source evidence into a demo, or enable real notifications for a demonstration.

For a private walkthrough, start the development stack using the repository's setup instructions and use its controlled mail and provider adapters. Verify the selected organization and role before demonstrating intake, inbox review, needs and reports. Explain that unknown duration and date remain unknown, that pending contributions do not count as approved time, and that a delivery attempt is not human acknowledgment. Review the inbox's original evidence and preserve possible duplicate imports for staff review.

For a production-profile rehearsal, use a unique isolated Compose project, throwaway credentials, separate volumes and a non-public host; do not point Caddy at the live domain or enable real providers. Follow [operations.md](operations.md) for migrations, stopping writers, backups and restore. The synthetic database-and-attachment recovery rehearsal does not prove a fresh-host TLS deployment or real provider operation.
