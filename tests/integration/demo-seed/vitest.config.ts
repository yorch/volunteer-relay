import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/demo-seed/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
