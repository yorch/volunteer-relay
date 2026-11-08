# Provisioning the first organization

A deployment operator can create a new organization for an existing verified credential account. The person first signs up through the application, requests email verification, and completes the verification link. Production SMTP delivery and the person's registered email address must be configured and working for that process. This command does not create an account, set a password, verify email, send mail, or change an existing organization's membership.

After migrations have been applied, run the command with Node 26.11.1 in a trusted operator environment. Provide a privileged `DATABASE_URL` through the environment or deployment secret mechanism; do not put database credentials in command arguments or logs. The production runtime database role may not have the necessary provisioning permissions.

```sh
node scripts/provision-organization.ts \
  --email owner@example.org \
  --name "Example Organization" \
  --slug example-organization \
  --timezone America/New_York
```

Use the intended owner's registered, verified email address. The slug must use lowercase letters and digits separated by single hyphens. The timezone must be recognized by the Node runtime. A case-insensitive existing organization name or an existing slug is refused. On success, stdout contains only a JSON object with the new `organizationId`. The transaction creates one owner membership and settings with the requested timezone and `review-all` policy. It does not assert that the owner has signed in or accepted an invitation. Initial provisioning has no application audit actor; retain the deployment operator's own change record if needed.

The command is not a recovery or promotion tool. A failed command exits nonzero without printing connection details. If the failure is ambiguous, inspect the database through the deployment's authorized operational process before retrying. A repeated successful command is refused; it does not create a second membership.
