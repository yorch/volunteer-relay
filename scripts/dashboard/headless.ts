import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config, State } from "../supervisor.ts";

const lanes = ["A", "B", "C", "D", "E", "F", "R", "V"] as const;
const count = (n: number | undefined) =>
  Number.isSafeInteger(n) && (n ?? -1) >= 0 ? n : null;

// Explicit projection: never forward config, notices, summaries or raw run logs.
export function projectHeadless(
  config: Config | null,
  value: State | null,
  now = Date.now(),
  alive: (pid: number) => boolean | null = () => null,
) {
  const fresh =
    value &&
    Number.isFinite(Date.parse(value.checkedAt)) &&
    now - Date.parse(value.checkedAt) <=
      ((config?.intervalSeconds ?? 10) * 2 + 5) * 1000;
  const state = !value
    ? "not-started"
    : !fresh
      ? "stale"
      : !value.running
        ? "stopped"
        : value.draining
          ? "draining"
          : "running";
  return {
    state,
    diskConfigAvailable: config !== null,
    checkedAt: value?.checkedAt ?? null,
    configReload:
      value?.configReload &&
      ["applied", "unchanged", "invalid", "deferred"].includes(
        value.configReload.outcome,
      )
        ? {
            outcome: value.configReload.outcome,
            errorCode: ["INVALID_CONFIG", "RESTART_REQUIRED"].includes(
              value.configReload.errorCode ?? "",
            )
              ? value.configReload.errorCode
              : null,
            evaluatedAt: Number.isFinite(
              Date.parse(value.configReload.evaluatedAt),
            )
              ? value.configReload.evaluatedAt
              : null,
          }
        : null,
    held: value?.held ?? [],
    budgets: config
      ? {
          maxParallel: config.maxParallel,
          intervalSeconds: config.intervalSeconds,
          maxRunMinutes: config.maxRunMinutes,
          maxRunsPerHour: config.maxRunsPerHour,
        }
      : null,
    lanes: lanes.map((lane) => {
      const records = Object.values(value?.records ?? {}).filter(
        (r) => r.lane === lane,
      );
      const r = records.sort((a, b) =>
        (b.startedAt ?? "").localeCompare(a.startedAt ?? ""),
      )[0];
      const enabled = config?.lanes[lane]?.enabled ?? false;
      const held = value?.held.includes(lane) ?? false;
      const processAlive = r?.pid ? alive(r.pid) : null;
      const status =
        r?.status === "running"
          ? fresh && value?.running && processAlive === true
            ? "running"
            : "stale"
          : held || r?.status === "paused"
            ? "paused"
            : !enabled
              ? "standby"
              : "idle";
      return {
        lane,
        enabled,
        status,
        reportedProcessStatus: r?.status ?? null,
        processAlive,
        task: r?.task ?? null,
        worktree: r?.cwd ?? null,
        harness: config
          ? `${config.lanes[lane]?.harness ?? "codex"} (configured); ${r ? `${r.harness ?? "codex"} recorded` : "no session recorded"}`
          : "Unknown (configuration unavailable)",
        configuredHarness:
          config?.lanes[lane]?.harness ?? (config ? "codex" : null),
        observedHarness: r ? (r.harness ?? "codex") : null,
        configuredModel:
          config?.lanes[lane]?.harness === "pi"
            ? config.lanes[lane]?.piModel
              ? `${config.lanes[lane].piModel.provider}/${config.lanes[lane].piModel.id}`
              : "Pi saved default (unspecified)"
            : (config?.lanes[lane]?.model ?? "CLI default (unspecified)"),
        observedModel: r?.observedModel ?? null,
        sessionId: r?.sessionId ?? null,
        pid: r?.pid ?? null,
        startedAt: r?.startedAt ?? null,
        finishedAt: r?.finishedAt ?? null,
        heartbeatAt: value?.checkedAt ?? null,
        reason: held
          ? `Operator hold${r?.reason ? ` · ${r.reason.slice(0, 500)}` : ""}`
          : (r?.reason?.slice(0, 500) ??
            (enabled ? "No run recorded" : "Lane disabled / on demand")),
        usage: {
          inputTokens: count(r?.inputTokens),
          outputTokens: count(r?.outputTokens),
          runsLastHour: records
            .flatMap((record) => record.runs)
            .filter((at) => at <= now && at > now - 3600000).length,
        },
      };
    }),
  };
}

export async function readHeadless(store: string) {
  async function read<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(
        await readFile(join(store, "supervisor", file), "utf8"),
      ) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  try {
    const [config, state] = await Promise.all([
      read<Config>("config.json").catch(() => null),
      read<State>("state.json"),
    ]);
    return projectHeadless(config, state, Date.now(), (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
      }
    });
  } catch {
    return { ...projectHeadless(null, null), state: "unavailable" };
  }
}
