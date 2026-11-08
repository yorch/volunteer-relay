import { constants } from "node:fs";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schedulingFingerprint } from "../scheduling.ts";
import type { Config, State } from "../supervisor.ts";
import type { Liveness, WatchdogInput, WatchdogSettings } from "./policy.ts";
import { checkWatchdog, startWatchdog } from "./service.ts";

async function privateJson(path: string): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 2097152 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        return null;
      return JSON.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
function liveness(pid: number | null): Liveness {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return "unknown";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "dead"
      : "unknown";
  }
}
const time = (value: unknown): number | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
export async function readHealth(
  store: string,
  now = Date.now(),
): Promise<WatchdogInput> {
  const state = (await privateJson(
    join(store, "supervisor/state.json"),
  )) as State | null;
  const config = (await privateJson(
    join(store, "supervisor/config.json"),
  )) as Config | null;
  const desired = (await privateJson(
    join(store, "supervisor/desired.json"),
  )) as { desiredRunning?: unknown } | null;
  const records = Object.values(state?.records ?? {}).slice(0, 128);
  const pid = Number.isSafeInteger(state?.pid) ? (state?.pid ?? null) : null;
  let disk: string | null = null;
  try {
    if (config) disk = schedulingFingerprint(config);
  } catch {
    /* unknown */
  }
  return {
    version: 1,
    now,
    desiredRunning:
      typeof desired?.desiredRunning === "boolean"
        ? desired.desiredRunning
        : null,
    supervisor: {
      pid,
      alive: liveness(pid),
      heartbeatAt: time(state?.checkedAt),
      draining: state?.draining === true,
    },
    children: records
      .filter((r) => r.status === "running" && Number.isSafeInteger(r.pid))
      .map((r) => ({ pid: r.pid as number, alive: liveness(r.pid ?? null) })),
    config: { loaded: state?.scheduling?.fingerprint ?? null, disk },
    queue: [],
    coordinator: {
      turnStartedAt: time(
        records.find((r) => r.lane === "A" && r.status === "running")
          ?.startedAt,
      ),
      oldestUnhandledAt: null,
    },
    availableCapacity: null,
    lanePauses: records
      .filter((r) => r.status === "paused")
      .slice(0, 64)
      .map((r) => ({
        lane: r.lane,
        reason: state?.held.includes(r.lane) ? "operator" : "failure",
      })),
    pendingOperations: [],
  };
}
export const settings: WatchdogSettings = {
  version: 1,
  intervalMs: 180000,
  startupGraceMs: 180000,
  stallMs: 600000,
  cooldownMs: 900000,
  backoffMs: 180000,
  maxBackoffMs: 3600000,
  recoveryEnabled: false,
};
async function main() {
  if (process.versions.node !== "26.11.1") throw Error("Use Node26.11.1");
  const action = process.argv[2];
  if (!["start", "once", "status"].includes(action ?? ""))
    throw Error("Use start|once|status");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const store = join(root, ".relay-coordination");
  const directory = join(store, "watchdog");
  if (action === "status") {
    console.log(
      JSON.stringify(await privateJson(join(directory, "latest.json"))),
    );
    return;
  }
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => controller.abort());
  const options = {
    directory,
    settings,
    signal: controller.signal,
    readInput: () => readHealth(store),
    notify: async (notice: { key: string; codes: string[] }) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, "notice.json");
      await writeFile(
        `${path}.tmp`,
        JSON.stringify({
          version: 1,
          at: new Date().toISOString(),
          key: notice.key,
          codes: notice.codes.slice(0, 64),
        }),
        { mode: 0o600 },
      );
      await rename(`${path}.tmp`, path);
    },
    requestRecovery: async () => {
      throw Error("Notice-only runner cannot restart supervisor");
    },
  };
  if (action === "once") await checkWatchdog(options);
  else await startWatchdog(options);
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error("Watchdog failed; inspect private health state");
    process.exitCode = 1;
  });
