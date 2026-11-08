import { defineConfig } from "vitest/config";

if (process.versions.node !== "26.11.1")
  throw new Error("Node 26.11.1 required");
export default defineConfig({
  test: {
    include: ["tests/integration/http-auth/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
