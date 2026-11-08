import { createHash } from "node:crypto";
import type { Config, Lane, State } from "./supervisor.ts";
export interface LoadedScheduling {
  fingerprint: string;
  allowedTasks: string[];
  enabledLanes: Lane[];
  maxParallel: number;
}
export const schedulingFingerprint = (config: Config) =>
  createHash("sha256").update(JSON.stringify(config)).digest("hex");
export function loadedScheduling(config: Config): LoadedScheduling {
  return {
    fingerprint: schedulingFingerprint(config),
    allowedTasks: [...config.allowedTasks],
    enabledLanes: Object.entries(config.lanes)
      .filter(([, v]) => v.enabled)
      .map(([lane]) => lane as Lane),
    maxParallel: config.maxParallel,
  };
}
export interface SchedulingTask {
  id: string;
  owner: string;
  state: string;
}
export function schedulingReason(
  task: SchedulingTask,
  state: State | null,
  config: Config | null,
  now = Date.now(),
) {
  const result = (code: string, label: string) => ({ code, label });
  if (task.state === "completed")
    return result("accepted", "Accepted task slice; not a process observation");
  if (task.state === "blocked")
    return result(
      "dependency-blocked",
      "Owner explicitly reported blocked; see its task update",
    );
  if (
    !state ||
    !Number.isFinite(Date.parse(state.checkedAt)) ||
    now - Date.parse(state.checkedAt) > 45000
  )
    return result("unknown", "Scheduling observation unavailable or stale");
  const records = Object.values(state.records).filter(
    (r) => r.lane === task.owner,
  );
  const current = records.find((r) => r.status === "running");
  if (current?.task === task.id)
    return result(
      "scheduled",
      "Native process reported running; productive work is not inferred",
    );
  if (
    state.held.includes(task.owner as Lane) ||
    records.some((r) => r.task === task.id && r.status === "paused")
  )
    return result("paused", "Lane/task is explicitly held or paused");
  if (state.draining || !state.running)
    return result("draining", "Supervisor is draining or stopped");
  const loaded = state.scheduling;
  if (!loaded)
    return result(
      "unknown",
      "Loaded scheduling configuration not recorded; on-disk config is not proof of reload",
    );
  const changed = config
    ? schedulingFingerprint(config) !== loaded.fingerprint
    : false;
  if (!loaded.allowedTasks.includes(task.id))
    return result(
      changed && config?.allowedTasks.includes(task.id)
        ? "reload-required"
        : "unsupported",
      changed && config?.allowedTasks.includes(task.id)
        ? "Task configured on disk but not loaded; safe supervisor reload required"
        : "Task excluded by loaded allowlist",
    );
  if (!loaded.enabledLanes.includes(task.owner as Lane))
    return result(
      changed && config?.lanes[task.owner as Lane]?.enabled
        ? "reload-required"
        : "disabled",
      changed && config?.lanes[task.owner as Lane]?.enabled
        ? "Lane enabled on disk but not loaded; safe supervisor reload required"
        : "Lane disabled in loaded configuration",
    );
  if (current)
    return result(
      "lane-busy",
      "Lane has another recorded native task/control run",
    );
  if (
    Object.values(state.records).filter((r) => r.status === "running").length >=
    loaded.maxParallel
  )
    return result(
      "waiting-capacity",
      `Waiting for one of ${loaded.maxParallel} total model slots`,
    );
  return result(
    "queued",
    "Queued for supervisor scheduling/setup; task progress is reported separately",
  );
}
