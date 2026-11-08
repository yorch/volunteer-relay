# Notification adapters

Exports implement the canonical `NotificationTransport` port. `createSafeTestTransport` is deterministic and stores delivery keys only in process memory. `createSmtpTransport` uses Nodemailer with caller-provided SMTP settings and a trusted recipient resolver. `createTelegramTransport` uses only `https://api.telegram.org` and an injected recipient resolver/fetch implementation; it never follows recipient-supplied URLs. Both provider adapters return `status: accepted`, which means provider acceptance only and never means a person acknowledged a need.

Transport adapters validate that links are same-app `/workspace/...` paths, deduplicate accepted delivery keys within the adapter process, and avoid logging credentials or payloads. Timeouts return retryable `DEPENDENCY_UNAVAILABLE` with an indeterminate outcome message: retry may duplicate an externally accepted message, so durable delivery state must use the canonical delivery key and make retries inspectable.

`routeNeedNotification` applies version-1 category routes or urgency fallback and filters recipients against the caller's current active-membership set. `evaluateNeedDeadlines` is pure over an injected `Date`; acknowledged, resolved and cancelled needs stop reminders. It does not send, persist escalation, or override organization policy.
