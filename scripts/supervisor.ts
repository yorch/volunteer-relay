import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSchedulingReload } from "./config-reload.ts";
import { control, validState } from "./control-policy.ts";
import { snapshot } from "./dashboard.ts";
import type { ScheduleResult } from "./fair-scheduler.ts";
import {
  assertSwitch,
  consumeEvent,
  type Harness,
  type HarnessStream,
  harnessCommand,
  harnessName,
  type LaneHarness,
  validateHarness,
  validFinal,
} from "./harness.ts";
import {
  createTraceStore,
  nativeTrace,
  type TraceInput,
} from "./operational-traces.ts";
import { evaluateOrchestration } from "./orchestration.ts";
import { type LoadedScheduling, loadedScheduling } from "./scheduling.ts";
import { evaluateTurnWait } from "./wait-policy.ts";
import { acquire } from "./watch.ts";

export const lanes = ["A", "B", "C", "D", "E", "F", "R", "V"] as const;
export type Lane = (typeof lanes)[number];
type Board = Awaited<ReturnType<typeof snapshot>>;
export interface Config {
  version: 1;
  root: string;
  binary: string;
  binaries?: Partial<Record<Harness, string>>;
  allowedTasks: string[];
  maxParallel: number;
  intervalSeconds: number;
  maxRunMinutes: number;
  maxRunsPerHour: number;
  confirmedStoppedAt: string;
  lanes: Partial<Record<Lane, LaneHarness & { enabled: boolean }>>;
}
export interface RecordState {
  key: string;
  lane: Lane;
  task: string | null;
  cwd: string;
  sessionId?: string;
  harness?: Harness;
  sessionEpoch?: string;
  observedModel?: string;
  runId?: string;
  traceLimited?: boolean;
  status: "running" | "idle" | "paused";
  reason: string;
  summary?: string;
  pid?: number;
  seen: string[];
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  runs: number[];
  progress?: string;
  noProgress: number;
  waitingForEvent?: boolean;
  finalState?: "working" | "waiting" | "ready" | "needs_operator";
  pauseKind?: "failure" | "operator" | "decision" | "no-progress";
  inputTokens: number;
  outputTokens: number;
}
export interface State {
  version: 1;
  running: boolean;
  checkedAt: string;
  pid: number;
  draining: boolean;
  held: Lane[];
  commands: string[];
  records: Record<string, RecordState>;
  notices: Partial<Record<Lane, string[]>>;
  attention?: {
    oldestUnhandledAt: number | null;
    planningSince: number | null;
    backlog: number;
    oldestReadyAt?: number | null;
  };
  noticeQueuedAt?: Partial<Record<Lane, string>>;
  scheduling?: LoadedScheduling;
  queue?: ScheduleResult;
  planning?: { event: string; taskIds: string[]; needed: boolean } | null;
  configReload?: {
    outcome: "applied" | "unchanged" | "invalid" | "deferred";
    errorCode: string | null;
    evaluatedAt: string;
  };
}
export interface Work {
  lane: Lane;
  key: string;
  task: string | null;
  events: string[];
  reason: string;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const taskId = (value: string) => /^P\d-\d{2}$/.test(value);
const git = (root: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  }).trim();
async function read<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
}
export function validateConfig(value: Config) {
  if (
    value.version !== 1 ||
    !isAbsolute(value.root) ||
    !isAbsolute(value.binary) ||
    !existsSync(value.binary)
  )
    throw new Error(
      "Configuration requires an existing absolute CLI binary and repository root",
    );
  if (
    !value.confirmedStoppedAt ||
    !Number.isFinite(Date.parse(value.confirmedStoppedAt))
  )
    throw new Error(
      "Confirm old harnesses stopped before enabling replacements",
    );
  if (
    !Array.isArray(value.allowedTasks) ||
    value.allowedTasks.some((id) => !taskId(id))
  )
    throw new Error("Explicit valid allowedTasks required");
  for (const [name, n, max] of [
    ["maxParallel", value.maxParallel, 4],
    ["intervalSeconds", value.intervalSeconds, 60],
    ["maxRunMinutes", value.maxRunMinutes, 60],
    ["maxRunsPerHour", value.maxRunsPerHour, 60],
  ] as const) {
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new Error(`Invalid ${name}`);
  }
  if (Object.keys(value.lanes).some((lane) => !lanes.includes(lane as Lane)))
    throw new Error("Unknown lane");
  for (const lane of Object.values(value.lanes)) {
    if (!lane || typeof lane.enabled !== "boolean")
      throw new Error("Lane enabled must be boolean");
    validateHarness(value, lane);
  }
  return value;
}
export function plan(
  board: Board,
  state: State,
  config: Config,
  now = Date.now(),
): Work[] {
  return evaluateOrchestration(board, state, config, now).work;
}

export function command(
  config: Config,
  record: RecordState,
  schema: string,
  output: string,
) {
  return harnessCommand(
    config,
    config.lanes[record.lane] ?? {},
    record,
    schema,
    output,
  );
}
async function workdir(work: Work, board: Board, config: Config) {
  if (work.lane === "A") return config.root;
  if (["R", "V"].includes(work.lane)) {
    const path = join(
      config.root,
      `.relay-local/headless/control/${work.lane}`,
    );
    await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }
  const task = board.tasks.find((t) => t.id === work.task);
  const live = task?.live;
  if (!live || live.assignment.owner !== work.lane)
    throw new Error("Assignment changed");
  const common = git(config.root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (live.claim) {
    if (
      live.claim.worktree === config.root ||
      git(live.claim.worktree, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]) !== common ||
      git(live.claim.worktree, ["branch", "--show-current"]) !==
        live.claim.branch
    )
      throw new Error("Claim/worktree mismatch; inspect before resuming");
    git(live.claim.worktree, [
      "merge-base",
      "--is-ancestor",
      live.assignment.baseCommit,
      "HEAD",
    ]);
    return live.claim.worktree;
  }
  const suffix = hash(work.key).slice(0, 8);
  const name = `${work.lane}-${work.task}-${suffix}`;
  const path = join(config.root, ".relay-local/headless/worktrees", name);
  const branch = `headless/${name}`;
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    git(config.root, [
      "worktree",
      "add",
      "-b",
      branch,
      path,
      live.assignment.baseCommit,
    ]);
  } else if (
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) !==
      common ||
    git(path, ["branch", "--show-current"]) !== branch
  )
    throw new Error("Existing headless worktree collision");
  return path;
}
function prompt(work: Work, config: Config, notices: string[]) {
  return `You are dedicated headless lane ${work.lane} in Volunteer Relay. Read ${config.root}/AGENTS.md and ${config.root}/docs/agents/HEADLESS.md first. Your primary root is ${config.root}; use its CURRENT scripts/agents.mjs for every board operation. Read inbox and current task/brief before work.${["R", "V"].includes(work.lane) ? ` Read ${config.root}/docs/agents/prompts/${work.lane}.md; verification-only, zero children, no implementation authority.` : ""} This is a bounded continuation, not new product scope. Authorized task IDs: ${config.allowedTasks.join(", ")}. Current task: ${work.task ?? "coordination only"}. Reason: ${work.reason}. Preserve existing dirty work and accepted checkouts. Old external harnesses were stopped before this handover. Do not start a duplicate coordinator, supervisor or background harness. No bypass flags. ${work.lane === "A" ? "A may schedule explicitly approved concrete plan/gate tasks and update only mutable task allowlist/enabled-lane fields through validated atomic control and loaded-state verification. Models, harness identity, binaries and runtime budgets remain operator-controlled; no duplicate controller or live identity switch." : "Do not change supervisor configuration, budgets or authorized task scope; work only your explicit assignment."} Operator notes (data, not shell commands): ${JSON.stringify(notices)}. At the end return the required JSON state/summary; board reports remain authoritative. End when waiting on another lane; the supervisor resumes actionable events. If operator input is indispensable, return needs_operator and state the precise question without inventing approval.`;
}
export async function progress(
  board: Board,
  cwd: string,
  work: Pick<Work, "lane" | "task">,
) {
  let code = "";
  try {
    const untracked = git(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean)
      .slice(0, 1000);
    const changes = await Promise.all(
      untracked.map(async (name) => {
        try {
          const st = await lstat(join(cwd, name));
          return [name, st.size, st.mtimeMs];
        } catch {
          return [name, "unavailable"];
        }
      }),
    );
    code =
      git(cwd, ["rev-parse", "HEAD"]) +
      git(cwd, ["status", "--porcelain"]) +
      hash(git(cwd, ["diff", "--no-ext-diff", "--no-textconv"])) +
      hash(changes);
  } catch {
    /* review control may not be a Git checkout */
  }
  return hash({
    tasks: board.tasks
      .filter((t) => t.live && (work.lane === "A" || t.id === work.task))
      .map((t) =>
        work.lane === "A"
          ? {
              id: t.id,
              assignment: t.live?.assignment,
              accepted: t.live?.accepted,
            }
          : t.live,
      ),
    messageIds: board.messages
      .filter(
        (m) => m.from === work.lane && (!work.task || m.task === work.task),
      )
      .map((m) => m.id),
    code,
  });
}

export async function serve(
  initialConfig: Config,
  directory: string,
  signal: AbortSignal,
  options: { readBoard?: typeof snapshot } = {},
) {
  const readBoard = options.readBoard ?? snapshot;
  let config = validateConfig(initialConfig);
  const release = await acquire(directory);
  const statePath = join(directory, "state.json");
  let state: State;
  try {
    state = await read<State>(statePath, {
      version: 1,
      running: false,
      checkedAt: "",
      pid: process.pid,
      draining: false,
      held: [],
      commands: [],
      records: {},
      notices: {},
    });
    if (!validState(state))
      throw new Error("Invalid supervisor state; inspect before starting");
  } catch (error) {
    await release();
    throw error;
  }
  const children = new Map<string, ChildProcess>();
  const settling = new Map<string, Promise<void>>();
  let saving = Promise.resolve();
  const save = () => {
    state.checkedAt = new Date().toISOString();
    const copy = JSON.parse(JSON.stringify(state));
    saving = saving.then(() => atomic(statePath, copy));
    return saving;
  };
  try {
    const traces = await createTraceStore(
      join(dirname(directory), "operational-traces"),
    );
    const latest = new Map<Lane, RecordState>();
    for (const r of Object.values(state.records).sort((a, b) =>
      (a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
    ))
      latest.set(r.lane, r);
    for (const [lane, prior] of latest)
      if (config.lanes[lane]?.enabled)
        assertSwitch(config.lanes[lane], prior, state.running);
    for (const record of Object.values(state.records)) {
      if (record.status !== "running") continue;
      if (!record.pid) {
        record.status = "paused";
        record.pauseKind = "failure";
        record.reason =
          "Prior run has no child identity; inspect and retry explicitly";
        continue;
      }
      let alive = true;
      try {
        process.kill(record.pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive)
        throw new Error(
          `Prior lane PID ${record.pid} may still be running; do not start overlapping writers`,
        );
      record.status = "paused";
      record.reason =
        "Prior run interrupted; inspect worktree and retry explicitly";
    }
    await traces.reconcile([]);
    state.scheduling = loadedScheduling(config);
    await atomic(join(directory, "desired.json"), {
      version: 1,
      desiredRunning: true,
      reason: "start",
      at: new Date().toISOString(),
    });
    state.running = true;
    state.pid = process.pid;
    state.draining = false;
    const commandsDir = join(directory, "commands");
    await mkdir(commandsDir, { recursive: true, mode: 0o700 });
    const schema = join(directory, "result-schema.json");
    await atomic(schema, {
      type: "object",
      properties: {
        state: {
          type: "string",
          enum: ["working", "waiting", "ready", "needs_operator"],
        },
        summary: { type: "string", maxLength: 2000 },
      },
      required: ["state", "summary"],
      additionalProperties: false,
    });
    // Ignore old, already-serviced history on first startup. Pending tasks/reviews bootstrap separately.
    const initial = await readBoard(config.root);
    const historical = initial.messages.map((m) => `message:${m.id}`);
    await save();
    while (!state.draining || children.size) {
      if (signal.aborted && !state.draining) {
        await atomic(join(directory, "desired.json"), {
          version: 1,
          desiredRunning: false,
          reason: "intentional-stop",
          at: new Date().toISOString(),
        });
        state.draining = true;
      }
      const pendingCommands = await Promise.all(
        (await readdir(commandsDir))
          .filter(
            (f) =>
              /^[a-f0-9-]{36}\.json$/.test(f) && !state.commands.includes(f),
          )
          .map(async (file) => ({
            file,
            value: await read<unknown>(join(commandsDir, file), null)
              .then(control)
              .catch(
                () => ({ action: "invalid" }) as ReturnType<typeof control>,
              ),
          })),
      );
      pendingCommands.sort(
        (a, b) =>
          (a.value.at ?? "").localeCompare(b.value.at ?? "") ||
          a.file.localeCompare(b.file),
      );
      for (const { file, value: c } of pendingCommands) {
        if (["stop", "rollout"].includes(c.action)) {
          await atomic(join(directory, "desired.json"), {
            version: 1,
            desiredRunning: c.action === "rollout",
            reason:
              c.action === "rollout"
                ? "authorized-rollout"
                : "intentional-stop",
            at: new Date().toISOString(),
          });
          state.draining = true;
        }
        if (c.lane && lanes.includes(c.lane)) {
          if (c.action === "pause" && !state.held.includes(c.lane))
            state.held.push(c.lane);
          if (c.action === "resume")
            state.held = state.held.filter((l) => l !== c.lane);
          if (
            ["retry", "resume"].includes(c.action) &&
            !state.held.includes(c.lane)
          ) {
            for (const r of Object.values(state.records).filter(
              (r) => r.lane === c.lane && r.status === "paused",
            )) {
              if (
                c.action === "retry" ||
                r.pauseKind === "operator" ||
                r.reason === "Operator hold"
              ) {
                r.status = "idle";
                r.noProgress = 0;
                delete r.pauseKind;
              }
            }
          }
          if (["nudge", "resume", "retry"].includes(c.action)) {
            state.noticeQueuedAt ??= {};
            state.noticeQueuedAt[c.lane] ??=
              c.at && Number.isFinite(Date.parse(c.at))
                ? c.at
                : new Date().toISOString();
            state.notices[c.lane] = [
              ...(state.notices[c.lane] ?? []),
              (c.text ?? `Operator requested ${c.action}`).slice(0, 32768),
            ].slice(-100);
          }
        }
        state.commands.push(file);
        state.commands = state.commands.slice(-2000);
        await save();
        await unlink(join(commandsDir, file)).catch(() => {});
      }
      if (!state.draining) {
        let candidate: unknown = null;
        try {
          candidate = JSON.parse(
            await readFile(join(directory, "config.json"), "utf8"),
          );
        } catch {
          /* invalid or incomplete replacement keeps last known good */
        }
        const decision = evaluateSchedulingReload(config, candidate, (value) =>
          validateConfig(value as Config),
        );
        config = decision.config;
        state.scheduling = loadedScheduling(config);
        state.configReload = {
          outcome: decision.outcome,
          errorCode: decision.errorCode,
          evaluatedAt: new Date().toISOString(),
        };
        let board: Board;
        try {
          board = await readBoard(config.root);
        } catch {
          console.error(
            "Board temporarily unavailable; retrying without launching lanes",
          );
          await save();
          await new Promise((resolve) =>
            setTimeout(resolve, config.intervalSeconds * 1000),
          );
          continue;
        }
        const evaluation = evaluateOrchestration(board, state, config);
        state.queue = evaluation.queue;
        state.planning = evaluation.planning;
        const pendingTimes = board.unanswered
          .filter((m) => m.to === "A")
          .map((m) => Date.parse(m.at))
          .filter(Number.isFinite);
        if (state.noticeQueuedAt?.A)
          pendingTimes.push(Date.parse(state.noticeQueuedAt.A));
        const planningIdle =
          !!evaluation.planning &&
          !board.tasks.some((t) => t.live && !t.live.accepted) &&
          !state.held.includes("A") &&
          !!config.lanes.A?.enabled;
        state.attention = {
          oldestUnhandledAt: pendingTimes.length
            ? Math.min(...pendingTimes)
            : null,
          planningSince: planningIdle
            ? (state.attention?.planningSince ?? Date.now())
            : null,
          backlog: evaluation.planning?.taskIds.length ?? 0,
          oldestReadyAt: board.tasks
            .filter(
              (t) =>
                t.live && !t.live.accepted && t.live.status?.state === "ready",
            )
            .reduce<number | null>((oldest, t) => {
              const readyAt = Date.parse(t.live?.status?.at ?? "");
              if (!Number.isFinite(readyAt)) return oldest;
              const progressAt = Math.max(
                readyAt,
                ...Object.values(state.records)
                  .filter((r) => r.task === t.id)
                  .flatMap((r) => [r.startedAt, r.finishedAt])
                  .filter((v): v is string => !!v)
                  .map(Date.parse)
                  .filter(Number.isFinite),
              );
              return oldest === null
                ? progressAt
                : Math.min(oldest, progressAt);
            }, null),
        };
        for (const work of evaluation.work) {
          if (children.size >= config.maxParallel) break;
          if (
            [...children.keys()].some(
              (k) => state.records[k]?.lane === work.lane,
            )
          )
            continue;
          let cwd: string;
          try {
            cwd = await workdir(work, board, config);
          } catch {
            state.records[work.key] = {
              ...state.records[work.key],
              key: work.key,
              lane: work.lane,
              task: work.task,
              cwd: config.root,
              status: "paused",
              pauseKind: "failure",
              reason:
                "Task checkout/setup validation failed; inspect ownership before retry",
              seen: state.records[work.key]?.seen ?? work.events,
              runs: state.records[work.key]?.runs ?? [],
              noProgress: 0,
              inputTokens: state.records[work.key]?.inputTokens ?? 0,
              outputTokens: state.records[work.key]?.outputTokens ?? 0,
              finishedAt: new Date().toISOString(),
            };
            await save();
            continue;
          }
          const old = state.records[work.key];
          const record: RecordState = old ?? {
            key: work.key,
            lane: work.lane,
            task: work.task,
            cwd,
            status: "idle",
            reason: "",
            seen: historical,
            runs: [],
            noProgress: 0,
            inputTokens: 0,
            outputTokens: 0,
          };
          if (old && old.cwd !== cwd) {
            record.status = "paused";
            record.pauseKind = "failure";
            record.reason =
              "Native session checkout changed; inspect before retry";
            await save();
            continue;
          }
          record.cwd = cwd;
          record.harness = harnessName(config.lanes[work.lane]);
          const sessionEpoch = config.lanes[work.lane]?.sessionEpoch;
          if (sessionEpoch) record.sessionEpoch = sessionEpoch;
          else delete record.sessionEpoch;
          record.status = "running";
          record.reason = work.reason;
          record.startedAt = new Date().toISOString();
          record.runs = record.runs.filter((t) => Date.now() - t < 3600000);
          record.runs.push(Date.now());
          record.seen = [...new Set([...record.seen, ...work.events])];
          const before = await progress(board, cwd, work);
          state.records[work.key] = record;
          const runId = `${Date.now()}-${randomUUID()}`;
          const logs = join(directory, "runs");
          await mkdir(logs, { recursive: true, mode: 0o700 });
          const output = join(logs, `${work.lane}-${runId}.result.json`);
          await writeFile(output, "", { flag: "wx", mode: 0o600 });
          record.runId = runId;
          let trace: Awaited<ReturnType<typeof traces.begin>>;
          try {
            trace = await traces.begin({
              runId,
              lane: work.lane,
              task: work.task,
              harness: record.harness ?? "codex",
            });
          } catch {
            record.status = "paused";
            record.reason =
              "Operational trace storage unavailable; inspect private disk";
            record.finishedAt = new Date().toISOString();
            await save();
            continue;
          }
          if (record.sessionId) trace.session(record.sessionId);
          let traceIOFailed = false;
          const emitTrace = (input: TraceInput) => {
            void trace.emit(input).catch(() => {
              traceIOFailed = true;
              record.traceLimited = true;
            });
          };
          emitTrace({ kind: "started" });
          let invocation: ReturnType<typeof command>;
          try {
            invocation = command(config, record, schema, output);
          } catch {
            record.status = "paused";
            record.pauseKind = "failure";
            record.reason = "Native invocation configuration rejected";
            record.finishedAt = new Date().toISOString();
            await trace.finish("paused", null);
            await save();
            continue;
          }
          if (invocation.harness === "pi")
            await mkdir(join(directory, "pi-sessions"), {
              recursive: true,
              mode: 0o700,
            });
          // Native session files inherit a private mask; restore before yielding.
          const previousMask = process.umask(0o077);
          let child: ChildProcess;
          try {
            child = spawn(invocation.binary, invocation.args, {
              cwd,
              env: {
                ...process.env,
                RELAY_COORD_DIR: dirname(directory),
                RELAY_HEADLESS_LANE: work.lane,
              },
              stdio: ["pipe", "pipe", "pipe"],
              detached: process.platform !== "win32",
            });
          } finally {
            process.umask(previousMask);
          }
          if (child.pid !== undefined) record.pid = child.pid;
          children.set(work.key, child);
          const notes = state.notices[work.lane] ?? [];
          delete state.notices[work.lane];
          if (state.noticeQueuedAt) delete state.noticeQueuedAt[work.lane];
          const stream: HarnessStream = {
            expectedCwd: cwd,
            ...(record.sessionId ? { sessionId: record.sessionId } : {}),
            inputTokens: 0,
            outputTokens: 0,
            settled: false,
            invalid: false,
          };
          let buffer = "";
          let droppingLine = false;
          let timedOut = false;
          let stderrOmitted = false,
            stdoutOmitted = false;
          child.stdout?.on("data", (chunk: Buffer) => {
            let text = chunk.toString();
            if (droppingLine) {
              const newline = text.indexOf("\n");
              if (newline < 0) return;
              text = text.slice(newline + 1);
              droppingLine = false;
            }
            buffer += text;
            let end = buffer.indexOf("\n");
            while (end >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              try {
                if (line.length > 4 * 1024 * 1024)
                  throw new Error("Oversized native metadata");
                const event = JSON.parse(line);
                const previousInput = stream.inputTokens,
                  previousOutput = stream.outputTokens;
                consumeEvent(invocation.harness, stream, event);
                if (stream.sessionId) {
                  record.sessionId = stream.sessionId;
                  trace.session(stream.sessionId);
                }
                for (const metadata of nativeTrace(invocation.harness, event))
                  emitTrace(metadata);
                if (stream.observedModel)
                  record.observedModel = stream.observedModel;
                record.inputTokens += stream.inputTokens - previousInput;
                record.outputTokens += stream.outputTokens - previousOutput;
              } catch {
                if (!stdoutOmitted) {
                  stdoutOmitted = true;
                  emitTrace({ kind: "omitted", channel: "stdout" });
                }
              }
              end = buffer.indexOf("\n");
            }
            if (buffer.length > 4 * 1024 * 1024) {
              buffer = "";
              droppingLine = true;
              emitTrace({ kind: "omitted", channel: "stdout" });
            }
          });
          child.stderr?.on("data", () => {
            if (!stderrOmitted) {
              stderrOmitted = true;
              emitTrace({ kind: "omitted", channel: "stderr" });
            }
          });
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            timedOut = true;
            killTimer = setTimeout(() => {
              try {
                process.kill(
                  process.platform === "win32"
                    ? (child.pid ?? 0)
                    : -(child.pid ?? 0),
                  "SIGKILL",
                );
              } catch {
                /* already exited */
              }
            }, 10000);
            try {
              process.kill(
                process.platform === "win32"
                  ? (child.pid ?? 0)
                  : -(child.pid ?? 0),
                "SIGTERM",
              );
            } catch {
              /* already exited */
            }
          }, config.maxRunMinutes * 60000);
          const finish = async (code: number | null) => {
            clearTimeout(timer);
            clearTimeout(killTimer);
            record.exitCode = code ?? 1;
            record.finishedAt = new Date().toISOString();
            delete record.pid;
            const final: unknown =
              invocation.harness === "pi"
                ? stream.settled && !stream.invalid && stream.sessionId
                  ? stream.final
                  : undefined
                : await read(output, {});
            const valid =
              validFinal(final) && !stream.invalid && !!stream.sessionId;
            if (invocation.harness === "pi" && valid)
              await atomic(output, final);
            const completedBoard = await readBoard(config.root);
            const after = await progress(completedBoard, cwd, work);
            const explicitWait =
              completedBoard.unanswered.some(
                (m) =>
                  m.from === work.lane &&
                  ["question", "request"].includes(m.kind),
              ) ||
              completedBoard.tasks.some(
                (t) =>
                  t.id === work.task && t.live?.status?.state === "blocked",
              );
            const wait = evaluateTurnWait({
              previousNoProgress: record.noProgress,
              progressChanged: after !== before,
              finalState: valid ? final.state : "working",
              failure: traceIOFailed
                ? "trace"
                : timedOut
                  ? "timeout"
                  : code !== 0
                    ? "cli"
                    : !valid
                      ? "invalid"
                      : null,
              operatorHeld: state.held.includes(work.lane),
              pendingEventIds: [],
              seenEventIds: [],
              explicitWait,
            });
            record.noProgress = wait.noProgress;
            record.waitingForEvent = wait.disposition === "waiting";
            record.progress = after;
            const pause = traceIOFailed
              ? "Operational trace persistence unavailable"
              : timedOut
                ? "Time budget reached"
                : code !== 0
                  ? "CLI run failed; inspect private log and retry"
                  : !valid
                    ? "No valid final result; inspect before retry"
                    : final.state === "needs_operator"
                      ? "Operator input needed"
                      : wait.reason === "operator"
                        ? "Operator hold"
                        : wait.reason === "no-progress"
                          ? "Two runs without recorded progress; inspect before retry"
                          : null;
            if (valid) record.finalState = final.state;
            if (pause)
              record.pauseKind =
                wait.reason === "operator"
                  ? final && valid && final.state === "needs_operator"
                    ? "decision"
                    : "operator"
                  : wait.reason === "no-progress"
                    ? "no-progress"
                    : "failure";
            else delete record.pauseKind;
            record.summary = valid ? final.summary : "";
            record.status = pause ? "paused" : "idle";
            record.reason =
              pause ?? (valid ? final.summary.slice(0, 500) : "Turn complete");
            await trace.finish(
              pause ? "paused" : "finished",
              valid ? final.state : null,
            );
            console.log(
              JSON.stringify({
                lane: work.lane,
                event: "finished",
                code: record.exitCode,
                status: record.status,
              }),
            );
            await save();
            const oldLogs = (await readdir(logs))
              .filter((name) => name.startsWith(`${work.lane}-`))
              .sort();
            for (const name of oldLogs.slice(0, -40))
              await unlink(join(logs, name));
          };
          let finished = false;
          const done = (code: number | null) => {
            if (finished) return;
            finished = true;
            const completion = finish(code)
              .catch(async () => {
                record.status = "paused";
                record.pauseKind = "failure";
                record.reason =
                  "Result handling failed; inspect controlled result and storage before retry";
                record.finishedAt = new Date().toISOString();
                delete record.pid;
                await trace.finish("paused", null).catch(() => {});
                await save();
              })
              .finally(() => {
                children.delete(work.key);
                settling.delete(work.key);
              });
            settling.set(work.key, completion);
            void completion.catch(() => {});
          };
          child.on("error", () => done(1));
          child.on("close", done);
          child.stdin?.on("error", () => {});
          child.stdin?.end(
            prompt(work, config, notes) +
              (invocation.harness === "pi"
                ? "\nReturn ONLY a JSON object with state (working/waiting/ready/needs_operator) and summary (max 2000 characters); no markdown or extra keys."
                : ""),
          );
          console.log(
            JSON.stringify({
              lane: work.lane,
              event: "started",
              task: work.task,
              pid: record.pid,
            }),
          );
          await save();
        }
      }
      await save();
      if (state.draining && !children.size) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.intervalSeconds * 1000);
        if (signal.aborted && !children.size) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  } catch (error) {
    state.draining = true;
    console.error(
      "Supervisor fault; draining owned runs before releasing ownership",
    );
    while (children.size)
      await new Promise((resolve) => setTimeout(resolve, 1000));
    throw error;
  } finally {
    await Promise.allSettled([...settling.values()]);
    state.running = false;
    state.draining = true;
    try {
      await save();
      await saving;
    } finally {
      await release();
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.versions.node !== "26.11.1")
      throw new Error("Use Node 26.11.1");
    const [action = "status", ...args] = process.argv.slice(2);
    const root = dirname(
      git(process.cwd(), [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]),
    );
    const ctx = JSON.parse(
      execFileSync(
        process.execPath,
        [join(root, "scripts/agents.mjs"), "init"],
        { cwd: root, encoding: "utf8" },
      ),
    ) as { store: string };
    const directory = join(ctx.store, "supervisor");
    if (action === "status")
      console.log(
        JSON.stringify(
          await read(join(directory, "state.json"), null),
          null,
          2,
        ),
      );
    else if (
      ["pause", "resume", "retry", "nudge", "stop", "rollout"].includes(action)
    ) {
      const laneIndex = args.indexOf("--lane");
      const lane = args[laneIndex + 1] as Lane;
      if (
        !["stop", "rollout"].includes(action) &&
        (!args.includes("--lane") || !lanes.includes(lane))
      )
        throw new Error("Specify --lane A|B|C|D|E|F|R|V");
      const textIndex = args.indexOf("--text");
      await atomic(join(directory, "commands", `${randomUUID()}.json`), {
        action,
        at: new Date().toISOString(),
        lane: ["stop", "rollout"].includes(action) ? undefined : lane,
        text: textIndex >= 0 ? args[textIndex + 1] : undefined,
      });
      console.log(`Queued ${action}${action === "stop" ? "" : ` for ${lane}`}`);
    } else if (action === "start") {
      const config = validateConfig(
        await read<Config>(join(directory, "config.json"), {} as Config),
      );
      if (config.root !== root)
        throw new Error(
          "Supervisor configuration belongs to another primary checkout",
        );
      const controller = new AbortController();
      for (const s of ["SIGINT", "SIGTERM"] as const)
        process.once(s, () => controller.abort());
      await serve(config, directory, controller.signal);
    } else
      throw new Error(
        "Use start, status, pause/resume/retry/nudge --lane X [--text message], stop (intentional) or rollout (authorized drain)",
      );
  } catch (error) {
    console.error(`supervisor: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
