import { defineConfig } from "drizzle-kit";

// Generate with: node packages/db/node_modules/drizzle-kit/bin.cjs generate \
//   --config packages/db/drizzle.config.ts
// Paths are declared relative to the repository root, matching that invocation.
export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/db/src/schema/index.ts",
  out: "./packages/db/migrations",
  strict: true,
  verbose: true,
});
