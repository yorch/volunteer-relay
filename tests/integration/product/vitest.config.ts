import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/product/**/*.test.ts"],
    environment: "node",
    // Several files reset the same disposable test database.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
