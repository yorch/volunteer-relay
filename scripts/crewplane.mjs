import { spawn, spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { constants } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const versionFile = new URL("../.crewplane-version", import.meta.url);
const installHelp =
  "See docs/agents/README.md for the pinned upstream installer.";

/** Relay policy adapter only. Scheduling, storage and harnesses belong to Crewplane. */
export async function runCrewplane(args, options = {}) {
  if (process.versions.node !== "26.11.1")
    throw Error("Relay launchers require Node 26.11.1");
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (env.RELAY_COORD_DIR)
    throw Error(
      "Unset RELAY_COORD_DIR. Legacy coordination is preserved, never imported or resumed.",
    );
  const storeOverride = env.CREWPLANE_COORD_DIR;
  if (
    storeOverride &&
    (!isAbsolute(storeOverride) ||
      basename(resolve(storeOverride)) !== ".crewplane-state")
  )
    throw Error(
      "Unset CREWPLANE_COORD_DIR; legacy/custom stores are not adopted",
    );
  const childEnv = { ...env };
  delete childEnv.CREWPLANE_COORD_DIR;
  const binary = env.CREWPLANE_BIN || "crewplane";
  if (env.CREWPLANE_BIN && !isAbsolute(binary))
    throw Error("CREWPLANE_BIN must be an absolute executable path");
  const expected = (await readFile(versionFile, "utf8")).trim();
  const probe = spawnSync(binary, ["--version"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0)
    throw Error(
      `Crewplane ${expected} is required on PATH (or CREWPLANE_BIN). ${installHelp}`,
    );
  if (probe.stdout.trim() !== expected)
    throw Error(
      `Crewplane version mismatch: expected ${expected}. ${installHelp}`,
    );

  if (storeOverride) {
    // Native supervised children inherit this exact default store. Permit that
    // binding, but never redirect a worker to a custom or another project's store.
    const selected = await realpath(storeOverride);
    const discovery = spawnSync(binary, ["--project", cwd, "init"], {
      cwd,
      env: childEnv,
      encoding: "utf8",
    });
    if (discovery.error || discovery.status !== 0)
      throw Error("Crewplane project discovery failed");
    const context = JSON.parse(discovery.stdout);
    if (selected !== (await realpath(context.store)))
      throw Error(
        "Unset CREWPLANE_COORD_DIR; it does not match this project's default namespace",
      );
  }

  if (args[0] === "agents" && args[1] === "prompt") {
    const lane = args[2];
    if (
      args.length !== 3 ||
      !["A", "B", "C", "D", "E", "F", "R", "V"].includes(lane)
    )
      throw Error("Use agents prompt A|B|C|D|E|F|R|V");
    const context = spawnSync(binary, ["--project", cwd, "init"], {
      cwd,
      env: childEnv,
      encoding: "utf8",
    });
    if (context.error || context.status !== 0)
      throw Error("Crewplane project discovery failed");
    const { root } = JSON.parse(context.stdout);
    if (typeof root !== "string" || !isAbsolute(root))
      throw Error("Invalid primary project identity");
    const names = ["R", "V"].includes(lane)
      ? [`prompts/${lane}.md`]
      : ["BOOTSTRAP.md", "COMMON.md", `prompts/${lane}.md`];
    // Resolve from the canonical primary, never from stale worker prompt copies.
    const parts = await Promise.all(
      names.map((name) => readFile(join(root, "docs/agents", name), "utf8")),
    );
    (options.output ?? console.log)(parts.join("\n\n"));
    return 0;
  }

  return new Promise((done, reject) => {
    const child = spawn(binary, ["--project", cwd, ...args], {
      cwd,
      env: childEnv,
      stdio: "inherit",
    });
    const handlers = new Map(
      ["SIGINT", "SIGTERM"].map((signal) => [signal, () => child.kill(signal)]),
    );
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    };
    child.once("error", () => {
      cleanup();
      reject(Error("Crewplane could not start"));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runCrewplane(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
