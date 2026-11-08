# Intake adapters

The package exports pure preview adapters from `src/index.ts`:

- `parseJsonImport` accepts a JSON array of message objects or `{ "messages": [...] }`. `ImportMapping` selects external ID, author, text and optional timestamp fields.
- `parseCsvImport` accepts UTF-8 comma-separated data with one header row, doubled quote escapes and quoted multiline fields. Header names are selected through the same mapping.
- For either format, timestamps must be ISO timestamps with an explicit offset (`dateFormat: "ISO"`) or the caller must choose `YYYY-MM-DD`, `MM/DD/YYYY` or `DD/MM/YYYY`. Date-only values mean midnight in the trusted context timezone. An ambiguous slash date (both first fields at most 12) is a row error.
- `parseWhatsAppTextExport` supports only lines shaped like `12/31/2024, 3:04 PM - Alice: message`, with `dateOrder: "MDY"` or `"DMY"` explicitly supplied. Lines after a message header are preserved as continuations. Group/system/attachment lines without a matching header are reported as unsupported. This parser does not support localized WhatsApp export variants.
- `normalizeTelegramUpdate` maps only Telegram `message` and `edited_message` payload fields. It preserves the raw message JSON and opaque photo descriptors but never downloads Telegram URLs/files.
- Attachment storage lives in `@relay/blob`; intake keeps only the compatibility re-exports and the Telegram/import mapping. Blob adapters enforce bounded size, PNG/JPEG/WebP magic validation and digest-derived keys, and expose one `PrivateBlobStore` contract for filesystem and S3-compatible backends.

All imports need a trusted context injected by the caller. In particular, organization IDs and author-to-membership mappings are never read from the imported rows as authority. Every parser returns row errors and preserves duplicate-looking messages in `sources`; `ambiguousDuplicates` groups those rows for caller review. IDs and idempotency keys are deterministic for the same organization, import channel identity and provider identity (or content plus duplicate ordinal where no provider ID exists). The adapters do not persist sources, preview choices, blob metadata or account-link tokens.

Telegram edits accept an optional trusted `previousRevision` supplied by persistence and produce its successor; absent that value, the first edit is revision 2. The Telegram `update_id` forms the stable per-update idempotency identity, while all edits share the message source ID. Callers must load the current revision before normalizing later edits; the adapter does not infer history from provider payloads.
