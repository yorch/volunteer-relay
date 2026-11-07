import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";

if (process.versions.node !== "26.11.1")
  throw new Error(`Use Node 26.11.1; got ${process.versions.node}`);
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code}`)),
    );
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => child.kill(signal));
  });
const next = ["apps/web/node_modules/next/dist/bin/next"];
const mode = process.argv[2];
if (mode === "web") await run([...next, "dev", "apps/web"]);
else if (mode === "dev")
  await Promise.all([
    run([...next, "dev", "apps/web"]),
    run(["--watch", "apps/worker/src/index.ts"]),
  ]);
else if (mode === "build") {
  await run([...next, "build", "apps/web"]);
  await mkdir("apps/worker/dist", { recursive: true });
  await copyFile("apps/worker/src/index.ts", "apps/worker/dist/index.ts");
} else if (mode === "typecheck") {
  await run([...next, "typegen", "apps/web"]);
  await run(["node_modules/typescript/bin/tsc", "--noEmit"]);
  await run([
    "node_modules/typescript/bin/tsc",
    "-p",
    "apps/web/tsconfig.json",
    "--noEmit",
  ]);
} else if (mode === "verify") {
  for (const args of [
    ["node_modules/@biomejs/biome/bin/biome", "check", "."],
    ["scripts/run.mjs", "typecheck"],
    ["node_modules/vitest/vitest.mjs", "run"],
    ["scripts/run.mjs", "build"],
  ])
    await run(args);
} else throw new Error("Unknown command");
