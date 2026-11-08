import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson } from "../atomic-json.ts";
import { schedulingFingerprint } from "../scheduling.ts";
import { type Config, validateConfig } from "../supervisor.ts";
import type { Liveness, WatchdogInput, WatchdogSettings } from "./policy.ts";
import { checkWatchdog, startWatchdog } from "./service.ts";

async function privateJson(path: string, maxBytes = 2097152): Promise<unknown> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > maxBytes ||
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
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const pidValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
const fingerprint = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
const laneNames = ["A", "B", "C", "D", "E", "F", "R", "V"];
const operationFile =
  /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/i;
async function operations(
  store: string,
  now: number,
): Promise<WatchdogInput["pendingOperations"]> {
  try {
    const directory = join(store, "operations");
    const stat = await lstat(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      return undefined;
    const files = (await readdir(directory)).filter((name) =>
      operationFile.test(name),
    );
    // An arbitrary historical prefix is not evidence that no pending stop or
    // rollout exists. Signal unavailable if this bounded projection overflows.
    if (files.length > 64) return undefined;
    const pending: NonNullable<WatchdogInput["pendingOperations"]> = [];
    for (const file of files) {
      const value = object(await privateJson(join(directory, file), 65536));
      const requestedAt = time(value?.requestedAt);
      if (
        value?.version !== 1 ||
        value.id !== file.slice(0, -5) ||
        !["rollout", "restart", "stop"].includes(value.kind as string) ||
        !["queued", "blocked", "handled", "completed"].includes(
          value.state as string,
        ) ||
        requestedAt === null ||
        requestedAt < 0 ||
        requestedAt > now
      )
        return undefined;
      pending.push({
        id: value.id as string,
        kind: value.kind as "rollout" | "restart" | "stop",
        state:
          value.state === "completed"
            ? "handled"
            : (value.state as "queued" | "blocked" | "handled"),
        requestedAt,
      });
    }
    return pending;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : undefined;
  }
}
const queueState = (
  reason: string,
  lane: string,
): WatchdogInput["queue"][number]["state"] | null => {
  if (["ELIGIBLE", "SELECTED"].includes(reason))
    return ["R", "V"].includes(lane) ? "review" : "eligible";
  if (
    [
      "CAPACITY",
      "COORDINATOR_RESERVED",
      "LANE_ACTIVE",
      "LANE_SELECTED",
    ].includes(reason)
  )
    return "capacity";
  if (reason === "RATE_LIMITED") return "rate";
  if (
    reason.startsWith("DEPENDENCY_") ||
    ["REVISION_PENDING", "BASE_UNACCEPTED", "TASK_FROZEN"].includes(reason)
  )
    return "dependency";
  if (reason === "PHASE_DISALLOWED") return "phase";
  if (["LANE_HELD", "LANE_DISABLED"].includes(reason)) return "hold";
  if (reason === "FAILURE_PAUSED") return "paused";
  if (
    reason.startsWith("CONFIG") ||
    [
      "UNAUTHORIZED",
      "OWNERSHIP_INVALID",
      "PATH_OVERLAP",
      "TASK_MISSING",
    ].includes(reason)
  )
    return "config";
  return null;
};
export async function readHealth(
  store: string,
  now = Date.now(),
  observe: (pid: number | null) => Liveness = liveness,
): Promise<WatchdogInput> {
  const state = object(await privateJson(join(store, "supervisor/state.json")));
  const config = await privateJson(join(store, "supervisor/config.json"));
  const desired = object(
    await privateJson(join(store, "supervisor/desired.json")),
  );
  const rawRecords = object(state?.records);
  const recordValues = Object.values(rawRecords ?? {});
  const records = recordValues
    .map(object)
    .filter(
      (r): r is Record<string, unknown> =>
        r !== null &&
        typeof r.lane === "string" &&
        laneNames.includes(r.lane) &&
        ["running", "idle", "paused"].includes(r.status as string),
    );
  // History is bounded by the private-file read limit, not an insertion-order
  // prefix: new task/review sessions must not disappear behind old records.
  // Pauses and coordinator turns describe the latest session for each lane;
  // all recorded running children remain relevant to orphan detection.
  const latest = new Map<string, Record<string, unknown>>();
  const activity = (record: Record<string, unknown>) =>
    Math.max(time(record.startedAt) ?? -1, time(record.finishedAt) ?? -1);
  for (const record of records) {
    const lane = record.lane as string;
    const previous = latest.get(lane);
    if (!previous || activity(record) >= activity(previous))
      latest.set(lane, record);
  }
  const currentRecords = [...latest.values()];
  const held =
    Array.isArray(state?.held) &&
    state.held.every(
      (lane) => typeof lane === "string" && laneNames.includes(lane),
    )
      ? (state.held as string[])
      : null;
  const pid = pidValue(state?.pid);
  const supervisorAlive = observe(pid);
  let disk: string | null = null;
  try {
    disk = schedulingFingerprint(validateConfig(config as Config));
  } catch {
    /* unavailable configuration */
  }
  const instant = (value: unknown): number | null =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= now
      ? value
      : null;
  const attention = object(state?.attention);
  const queue: WatchdogInput["queue"] = [];
  const planningSince = instant(attention?.planningSince);
  const schedule = object(state?.queue);
  const rows =
    schedule?.version === 1 && Array.isArray(schedule.queue)
      ? schedule.queue
      : [];
  const projected = rows.flatMap((row) => {
    const value = object(row);
    if (
      !value ||
      typeof value.key !== "string" ||
      !/^[\w.:/-]{1,256}$/.test(value.key) ||
      !laneNames.includes(value.lane as string) ||
      !["eligible", "selected", "blocked", "capacity"].includes(
        value.status as string,
      ) ||
      typeof value.reason !== "string"
    )
      return [];
    const wait = queueState(value.reason, value.lane as string);
    if (!wait) return [];
    const since = instant(object(value.components)?.enqueue);
    const progress = records
      .filter(
        (record) => record.lane === value.lane && record.task === value.taskId,
      )
      .flatMap((record) =>
        [time(record.startedAt), time(record.finishedAt)].flatMap((at) =>
          at !== null && instant(at) !== null ? [at] : [],
        ),
      );
    return [
      {
        id: value.key,
        lane: value.lane as string,
        state: wait,
        since,
        lastProgressAt: progress.length ? Math.max(...progress) : null,
      },
    ];
  });
  // Bounded details prioritize actionable waits, not a benign historical prefix.
  projected.sort(
    (a, b) =>
      Number(!["eligible", "review", "failed"].includes(a.state)) -
      Number(!["eligible", "review", "failed"].includes(b.state)),
  );
  if (
    planningSince !== null &&
    typeof attention?.backlog === "number" &&
    Number.isSafeInteger(attention.backlog) &&
    attention.backlog > 0
  ) {
    const blocked = projected.find(
      (entry) =>
        entry.lane === "A" && !["eligible", "review"].includes(entry.state),
    );
    queue.push({
      id: "A:planning",
      lane: "A",
      state: held?.includes("A") ? "hold" : (blocked?.state ?? "eligible"),
      since: planningSince,
      lastProgressAt: planningSince,
    });
  }
  const oldestReady = instant(attention?.oldestReadyAt);
  if (oldestReady !== null) {
    const blocked = projected.find(
      (entry) =>
        entry.lane === "A" && !["eligible", "review"].includes(entry.state),
    );
    queue.push({
      id: "A:disposition",
      lane: "A",
      state: held?.includes("A") ? "hold" : (blocked?.state ?? "review"),
      since: oldestReady,
      lastProgressAt: oldestReady,
    });
  }
  queue.push(...projected.slice(0, 64 - queue.length));
  const maxParallel = object(state?.scheduling)?.maxParallel;
  const pendingOperations = await operations(store, now);
  const availableCapacity =
    typeof maxParallel === "number" &&
    Number.isInteger(maxParallel) &&
    maxParallel >= 1 &&
    maxParallel <= 4 &&
    rawRecords !== null &&
    records.length === recordValues.length
      ? Math.max(
          0,
          maxParallel -
            records.filter((record) => record.status === "running").length,
        )
      : null;
  const availableSignals = [
    ...(schedule?.version === 1 &&
    Array.isArray(schedule.queue) &&
    rows.length <= 64 &&
    projected.length === rows.length
      ? ["queue"]
      : []),
    ...(availableCapacity !== null ? ["capacity"] : []),
    ...(attention?.oldestUnhandledAt === null ||
    instant(attention?.oldestUnhandledAt) !== null
      ? ["oldest steering"]
      : []),
    ...(pendingOperations !== undefined ? ["operations"] : []),
  ];
  return {
    version: 1,
    now,
    availableSignals,
    desiredRunning:
      typeof desired?.desiredRunning === "boolean"
        ? desired.desiredRunning
        : null,
    supervisor: {
      pid,
      alive: supervisorAlive,
      heartbeatAt: time(state?.checkedAt),
      draining:
        state?.draining === true &&
        state?.running === true &&
        supervisorAlive === "alive",
    },
    children: records
      .filter((r) => r.status === "running" && pidValue(r.pid) !== null)
      .map((r) => ({
        pid: pidValue(r.pid) as number,
        alive: observe(pidValue(r.pid)),
      })),
    config: {
      loaded: fingerprint(object(state?.scheduling)?.fingerprint),
      disk,
    },
    queue,
    coordinator: {
      turnStartedAt: time(
        currentRecords.find((r) => r.lane === "A" && r.status === "running")
          ?.startedAt,
      ),
      oldestUnhandledAt: instant(attention?.oldestUnhandledAt),
    },
    availableCapacity,
    lanePauses: currentRecords
      .filter((r) => r.status === "paused")
      .slice(0, 64)
      .map((r) => ({
        lane: r.lane as string,
        reason: held?.includes(r.lane as string)
          ? "operator"
          : ["failure", "no-progress"].includes(r.pauseKind as string)
            ? "failure"
            : ["operator", "decision"].includes(r.pauseKind as string)
              ? "operator"
              : r.waitingForEvent === true
                ? "waiting"
                : "unknown",
      })),
    ...(pendingOperations ? { pendingOperations } : {}),
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
export async function deliverNotice(
  store: string,
  notice: { key: string; codes: string[] },
) {
  const faults = new Set([
    "supervisor-dead",
    "supervisor-stale",
    "supervisor-unknown",
    "heartbeat-unknown",
    "config-mismatch",
    "steering-stalled",
    "coordinator-long-turn",
    "pause-failure",
    "pause-unknown",
    "operation-stalled",
    "orphan-or-unknown-child",
    "task-failed",
    "review-stalled",
    "eligible-stalled",
  ]);
  const codes = [
    ...new Set(notice.codes.filter((code) => faults.has(code))),
  ].sort();
  if (!codes.length) return;
  const safeDirectory = async (path: string) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw Error("Unsafe notice directory");
  };
  const directory = join(store, "watchdog");
  await safeDirectory(directory);
  await atomicJson(join(directory, "notice.json"), {
    version: 1,
    at: new Date().toISOString(),
    key: codes.join(","),
    codes,
  });
  // A notice is a bounded informational wake-up, never a retry, acceptance,
  // budget increase, service restart, or override of an intentional stop/hold.
  const intent = object(
    await privateJson(join(store, "supervisor/desired.json")),
  );
  if (intent?.desiredRunning !== true) return;
  await safeDirectory(join(store, "supervisor"));
  await safeDirectory(join(store, "supervisor/commands"));
  await atomicJson(join(store, "supervisor/commands", `${randomUUID()}.json`), {
    action: "nudge",
    lane: "A",
    at: new Date().toISOString(),
    text: "Watchdog reports an orchestration condition. Read private watchdog status and the task/operation queue. Preserve operator holds, failure pauses, phase gates and runtime budgets.",
  });
}
async function main() {
  if (process.versions.node !== "26.11.1") throw Error("Use Node26.11.1");
  const action = process.argv[2];
  if (!["start", "once", "status"].includes(action ?? ""))
    throw Error("Use start|once|status");
  let store: string;
  if (process.env.RELAY_COORD_DIR !== undefined) {
    if (!isAbsolute(process.env.RELAY_COORD_DIR))
      throw Error("RELAY_COORD_DIR must be absolute");
    store = resolve(process.env.RELAY_COORD_DIR);
  } else {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 5000, maxBuffer: 8192 },
    ).trim();
    if (!isAbsolute(common)) throw Error("Invalid Git common directory");
    store = join(dirname(common), ".relay-coordination");
  }
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
    notify: (notice: { key: string; codes: string[] }) =>
      deliverNotice(store, notice),
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
