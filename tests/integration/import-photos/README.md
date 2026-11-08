# Import photo helper tests

Run with `node node_modules/vitest/vitest.mjs run --config tests/integration/import-photos/vitest.config.ts`. The tests use synthetic images and perform no filesystem writes or provider calls.

Multipart requests use one `data` JSON field and up to ten repeated `files` fields. An explicit `photoMapping` maps external message IDs to arrays of uploaded filenames. When `photoMapping` is absent, JSON original rows may use a `photos` array or pipe-delimited string, and CSV rows may use a `photos` column containing pipe-delimited filenames. References are names only, not filesystem paths. Preview errors must block confirmation. The caller is responsible for persisting sanitized blobs and sources and handling failure atomically.
