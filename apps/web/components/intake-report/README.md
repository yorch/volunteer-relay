# Text intake preview

P2-02 uses `TextIntake({ submit })`, where submit accepts canonical WebSourceSubmission and returns Promise<Result<Receipt>>. The command contains only schemaVersion, idempotencyKey and original text; no client tenant/author/timestamp authority. Schema validation rejects blank or >20,000 UTF-16-code-unit input. Unknown time is not inferred. Duplicate clicks are locked while pending, retries retain the exact command, and editing the draft starts a new identity. Errors retain the draft and show safe local copy instead of provider/source error text. Receipt/reset transitions move focus to the new result or input.

`IntakePreview` supplies in-memory callbacks for success, unavailable service, and a controlled transient failure: retry must preserve key and text to succeed. Its 700ms delay demonstrates pending UI only. Changing the scenario deliberately resets the specimen. No HTTP, storage, model, upload or domain operation runs. Drafts and simulated receipts vanish on reload. The receipt has no link into staff evidence.

The server page `/workspace/volunteer` requires NODE_ENV=development and otherwise calls notFound; force-dynamic prevents preview pre-rendering. Foundation and volunteer shell are consumed read-only. Real authentication, submission authority, durable receipt and own-status queries require A/B/C integration through a later bounded assignment. All fixture pages visibly state no data saved; keep those labels until actual authorized services replace them.

Browser coverage lives in tests/e2e/ui/volunteer/intake.spec.ts. Run under Node 26.11.1 using PLAYWRIGHT_PORT=3113 bun run test:e2e. No database or provider check applies to this presentation slice.
