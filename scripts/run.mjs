import { spawn } from "node:child_process";

if (process.versions.node !== "26.11.1")
  throw new Error(`Use Node 26.11.1; got ${process.versions.node}`);
// Starts a child with inherited stdio and forwards interrupts to it. `done`
// settles when the child exits; a non-zero exit rejects.
const start = (args, extraEnv = {}) => {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...extraEnv },
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => child.kill(signal));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code ?? signal}`)),
    );
  });
  return { child, done };
};
const run = (args, extraEnv) => start(args, extraEnv).done;
const next = ["apps/web/node_modules/next/dist/bin/next"];
const mode = process.argv[2];
if (mode === "e2e:web") {
  const port = Number(process.env.PLAYWRIGHT_PORT ?? "3190");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid PLAYWRIGHT_PORT");
  // Browser runs keep their own build directory so a concurrent `next build`,
  // `next typegen` or `next dev` in .next cannot reload the served app.
  await run(
    [
      ...next,
      "dev",
      "apps/web",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { RELAY_NEXT_DIST_DIR: ".next-e2e" },
  );
} else if (mode === "web") await run([...next, "dev", "apps/web"]);
else if (mode === "dev") {
  const web = start([...next, "dev", "apps/web"]);
  const worker = start(["--watch", "apps/worker/src/index.ts"]);
  // One failing child must not leave its sibling running unattended.
  await Promise.all([web.done, worker.done]).catch((error) => {
    web.child.kill("SIGTERM");
    worker.child.kill("SIGTERM");
    throw error;
  });
} else if (mode === "build") await run([...next, "build", "apps/web"]);
else if (mode === "typecheck") {
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
