import { spawn } from "node:child_process";

if (process.versions.node !== "26.11.1") throw new Error("Use Node 26.11.1");
const configs = [
  "packages/db/vitest.integration.config.ts",
  "tests/integration/processing/vitest.config.ts",
  "tests/integration/follow-through/vitest.config.ts",
  "tests/integration/retention/vitest.config.ts",
  "tests/integration/product-acceptance/vitest.config.ts",
  "tests/integration/product-operations/vitest.config.ts",
  "tests/integration/runtime-privacy/vitest.config.ts",
  "tests/integration/provisioning/vitest.config.ts",
  "tests/integration/import-photos/vitest.config.ts",
  "tests/integration/product/vitest.config.ts",
];
for (const config of configs) {
  console.info(`Product integration: ${config}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", "--config", config],
      { stdio: "inherit", env: process.env },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code !== 0) {
    process.exitCode = Number(code);
    break;
  }
}
