if (process.versions.node !== "26.11.1")
  throw new Error("Tests require Node 26.11.1");

import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "fixtures/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
  },
});
