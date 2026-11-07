if (process.versions.node !== "26.11.1")
  throw new Error("Integration tests require Node 26.11.1");

import { defineConfig } from "vitest/config";

// Package-owned integration config: root Vitest deliberately excludes
// tests/integration. Run with an explicit environment file, for example:
//   node --env-file=.env.local node_modules/vitest/vitest.mjs run \
//     --config packages/db/vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ["tests/integration/auth/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One private test database shared by the suite: no parallel truncation.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
