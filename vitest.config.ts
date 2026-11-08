if (process.versions.node !== "26.11.1")
  throw new Error("Tests require Node 26.11.1");

import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "fixtures/**/*.test.ts",
      "scripts/**/*.test.ts",
      // Colocated app tests. The web handlers are pure TypeScript (no Next.js
      // imports), so they can be exercised without a browser or a database.
      "apps/web/**/*.test.ts",
      "video/src/**/*.test.ts",
    ],
    environment: "node",
  },
});
