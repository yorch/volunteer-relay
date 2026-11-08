import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGraph, type GraphInput } from "./dashboard/graph-builder.ts";
import { readHeadless } from "./dashboard/headless.ts";
import { createTraceStore, traceIdPattern } from "./operational-traces.ts";
import { schedulingFingerprint, schedulingReason } from "./scheduling.ts";
import type { Config, State } from "./supervisor.ts";
import { watchdogHealth } from "./watchdog/dashboard.ts";

interface Message {
  reviewCommit?: string;
  id: string;
  at: string;
  from: string;
  to: string;
  kind: string;
  task: string | null;
  replyTo: string | null;
  text: string;
}
interface LiveTask {
  scope?: { version: 1; paths: string[] } | null;
  scheduling?: import("./fair-scheduler.ts").Metadata | null;
  task: string;
  assignment: { owner: string; baseCommit: string; at: string; text: string };
  claim: { branch: string; worktree: string; at: string } | null;
  status: {
    state: string;
    text: string;
    at: string;
    commit: string | null;
    checkpointed?: boolean;
  } | null;
  accepted: {
    commit: string;
    sourceCommit?: string;
    at: string;
    text: string;
  } | null;
}
interface Board {
  store: string;
  tasks: LiveTask[];
  messages: Message[];
  unanswered: Message[];
}
const assets = new URL("./dashboard/", import.meta.url);
const cli = fileURLToPath(new URL("./agents.mjs", import.meta.url));

export function parseTask(id: string, markdown: string, live?: LiveTask) {
  const documentedStatus =
    markdown.match(/Status:\s*([^\n]+)/)?.[1] ?? "Not started";
  const documentedComplete =
    /^(complete\b|accepted\b|reviewed\/integrated\b)/i.test(documentedStatus);
  const state = live?.accepted
    ? "completed"
    : live?.status?.state === "ready"
      ? "review"
      : live?.status?.state === "blocked"
        ? "blocked"
        : live?.status?.state === "working"
          ? "working"
          : live?.assignment
            ? "assigned"
            : documentedComplete
              ? "completed"
              : /^in progress\b/i.test(documentedStatus)
                ? "working"
                : "todo";
  return {
    id,
    title: markdown.split("\n")[0]?.replace(/^#\s*/, "") ?? id,
    owner:
      live?.assignment.owner ??
      markdown.match(/Owner(?: lane)?:\s*([A-F])\b/)?.[1] ??
      "—",
    phase: id.slice(1, 2),
    state,
    documentedStatus,
    goal: markdown.match(/^Goal:\s*(.+)/m)?.[1] ?? "See task card",
    dependencies:
      markdown.match(/^(?:Prerequisites|Dependencies):\s*(.+)/m)?.[1] ??
      "See task card",
    scheduling: {
      code: "unknown",
      label: "Scheduling observation unavailable",
    },
    markdown,
    live: live ?? null,
  };
}

export function plannedTasks(plan: string, existingIds: Set<string>) {
  const line = plan.match(/^Illustrative task IDs:\s*(.+)$/m)?.[1] ?? "";
  return [...line.matchAll(/(P\d-\d{2})\s+([^;.]+)/g)]
    .filter((match) => !existingIds.has(match[1] ?? ""))
    .map((match) =>
      parseTask(
        match[1] ?? "",
        `# ${match[1]} — ${match[2]}\nStatus: planning placeholder; no scoped card or assignment.\nGoal: Needs scoping — ${match[2]}. This roadmap item is not authorized for implementation.\nDependencies: coordinator task definition and phase gates.\n`,
      ),
    );
}

export async function monitorStatus(store: string, now = new Date()) {
  try {
    const value = JSON.parse(
      await readFile(join(store, "monitor/latest.json"), "utf8"),
    ) as {
      running: boolean;
      checkedAt: string;
      intervalSeconds: number;
      alerts: Array<{
        key: string;
        kind: string;
        agent: string;
        task: string | null;
        text: string;
      }>;
      error: string | null;
    };
    if (
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      !Number.isFinite(value.intervalSeconds) ||
      value.intervalSeconds < 1 ||
      !Array.isArray(value.alerts)
    )
      throw new Error("Invalid monitor snapshot");
    const stale =
      now.getTime() - Date.parse(value.checkedAt) >
      (value.intervalSeconds * 2 + 5) * 1000;
    return {
      ...value,
      state: !value.running
        ? "stopped"
        : stale
          ? "stale"
          : value.error
            ? "error"
            : "running",
    };
  } catch (error) {
    return {
      state:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "not-started"
          : "unavailable",
      checkedAt: null,
      alerts: [],
      error: null,
    };
  }
}

export const headlessStatus = readHeadless;

export async function snapshot(root: string) {
  const board: Board = JSON.parse(
    execFileSync(process.execPath, [cli, "board"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10000,
    }),
  );
  const cards = (await readdir(join(root, "docs/tasks")))
    .filter((f) => /^P\d-\d{2}\.md$/.test(f))
    .sort();
  const tasks = await Promise.all(
    cards.map(async (file) => {
      const id = file.slice(0, -3);
      return parseTask(
        id,
        await readFile(join(root, "docs/tasks", file), "utf8"),
        board.tasks.find((t) => t.task === id),
      );
    }),
  );
  const plan = await readFile(
    join(root, "IMPLEMENTATION-PLAN.md"),
    "utf8",
  ).catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  tasks.push(...plannedTasks(plan, new Set(tasks.map((task) => task.id))));
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  const [runtime, configured] = await Promise.all([
    readFile(join(board.store, "supervisor/state.json"), "utf8")
      .then((s) => JSON.parse(s) as State)
      .catch(() => null),
    readFile(join(board.store, "supervisor/config.json"), "utf8")
      .then((s) => JSON.parse(s) as Config)
      .catch(() => null),
  ]);
  for (const task of tasks)
    task.scheduling = schedulingReason(task, runtime, configured);
  const headless = await headlessStatus(board.store);
  const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n\n")
    .map((entry) => ({
      path: entry.match(/^worktree (.+)$/m)?.[1],
      branch: entry.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? "detached",
    }));
  const agents = headless.lanes.map((lane) => {
    const task =
      board.tasks.find((t) => t.task === lane.task) ??
      board.tasks.find((t) => t.assignment.owner === lane.lane && !t.accepted);
    const worktree = lane.worktree ?? task?.claim?.worktree ?? null;
    return {
      ...lane,
      task: lane.task ?? task?.task ?? null,
      worktree,
      branch: worktrees.find((w) => w.path === worktree)?.branch ?? null,
      taskStatus: task?.accepted
        ? "accepted"
        : (task?.status?.state ?? (task ? "assigned" : null)),
      reason:
        task?.accepted && lane.status === "idle"
          ? "Last task accepted; no active native run"
          : lane.reason,
      assignments: board.tasks
        .filter((t) => t.assignment.owner === lane.lane && !t.accepted)
        .map((t) => ({ task: t.task, state: t.status?.state ?? "assigned" })),
      acceptedCommit: task?.accepted?.commit ?? null,
    };
  });
  const graphInput: GraphInput = {
    version: 1,
    tasks: tasks
      .filter((t) => t.live?.assignment)
      .map((t) => ({
        id: t.id,
        label: t.title.slice(0, 256),
        status: t.live?.accepted
          ? "accepted"
          : (t.live?.status?.state ?? "assigned"),
        accepted: Boolean(t.live?.accepted),
        dependsOn:
          t.live?.scheduling?.dependsOn.map((dep) => ({
            taskId: dep.taskId,
            require: dep.require,
          })) ?? [],
      })),
    lanes: agents.map((lane) => ({
      id: lane.lane,
      role:
        lane.lane === "A"
          ? "Coordinator"
          : lane.lane === "R"
            ? "Code review"
            : lane.lane === "V"
              ? "Browser QA"
              : "Implementation",
      harness: lane.observedHarness,
      observedModel: lane.observedModel,
      taskId: lane.task,
      processStatus: lane.status,
      taskStatus: lane.taskStatus,
      accepted: Boolean(lane.acceptedCommit),
    })),
    messages: board.messages
      .slice(-1000)
      .filter((m) =>
        ["question", "request", "answer", "update", "handoff"].includes(m.kind),
      )
      .map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        kind: m.kind as GraphInput["messages"][number]["kind"],
        task: m.task,
        replyTo: m.replyTo,
        at: m.at,
      })),
    unansweredIds: board.unanswered.slice(-1000).map((m) => m.id),
  };
  return {
    graphs: {
      dependencies: buildGraph(graphInput, "dependencies"),
      communication: buildGraph(graphInput, "communication"),
    },
    graphCoverage: {
      messagesTotal: board.messages.length,
      messagesIncluded: graphInput.messages.length,
      dependencyMetadata: `${tasks.filter((t) => t.live?.scheduling).length} structured schedules; legacy dependencies unavailable`,
    },
    updatedAt: new Date().toISOString(),
    monitor: await monitorStatus(board.store),
    watchdog: await watchdogHealth(board.store),
    headless: {
      ...headless,
      configState:
        !runtime?.scheduling || !configured
          ? "unknown (runtime provenance unavailable)"
          : runtime.scheduling.fingerprint === schedulingFingerprint(configured)
            ? "current"
            : "reload required (disk config differs from runtime)",
      lanes: agents,
    },
    tasks,
    messages: board.messages,
    unanswered: board.unanswered,
    orphanAssignments: board.tasks.filter(
      (t) => !tasks.some((card) => card.id === t.task),
    ),
    milestoneStatus: await readFile(join(root, "docs/STATUS.md"), "utf8"),
  };
}

export function createDashboard(root: string) {
  let traces: ReturnType<typeof createTraceStore> | undefined;
  const getTraces = () =>
    (traces ??= (async () => {
      const { store } = JSON.parse(
        execFileSync(process.execPath, [cli, "init"], {
          cwd: root,
          encoding: "utf8",
        }),
      );
      return createTraceStore(join(store, "operational-traces"));
    })());
  return createServer(async (request, response) => {
    const address = response.socket?.localPort;
    const expectedHost = `127.0.0.1:${address}`;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    if (
      request.headers.host !== expectedHost ||
      (request.headers.origin &&
        request.headers.origin !== `http://${expectedHost}`)
    ) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    try {
      if (request.url === "/api/snapshot") {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.end(JSON.stringify(await snapshot(root)));
        return;
      }
      if (request.url?.startsWith("/api/runs")) {
        const url = new URL(request.url, `http://${expectedHost}`);
        const parts = url.pathname.split("/");
        const number = (name: string, fallback: number) => {
          const v = url.searchParams.get(name);
          if (v !== null && !/^\d{1,8}$/.test(v)) throw Error("Invalid cursor");
          return v === null ? fallback : Number(v);
        };
        try {
          const store = await getTraces();
          let value: unknown;
          if (url.pathname === "/api/runs") {
            const task = url.searchParams.get("task");
            if (task && !/^P\d-\d{2}$/.test(task)) throw Error("Invalid task");
            const lane = url.searchParams.get("lane"),
              harness = url.searchParams.get("harness"),
              before = url.searchParams.get("before");
            if (
              (lane && !/^[A-FRV]$/.test(lane)) ||
              (harness && !["codex", "pi"].includes(harness))
            )
              throw Error("Invalid filter");
            value = await store.list({
              ...(lane ? { lane } : {}),
              ...(task ? { task } : {}),
              ...(harness ? { harness } : {}),
              ...(before ? { before } : {}),
              limit: number("limit", 20),
            });
          } else if (parts.length === 4 && traceIdPattern.test(parts[3] ?? ""))
            value = await store.tail(
              parts[3] ?? "",
              number("after", 0),
              number("limit", 100),
            );
          else {
            response.writeHead(404).end("Not found");
            return;
          }
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify(value));
        } catch {
          response
            .writeHead(400, { "Content-Type": "application/json" })
            .end(
              JSON.stringify({ error: "Run unavailable or invalid request" }),
            );
        }
        return;
      }
      const routes: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/dashboard.js": ["dashboard.js", "text/javascript"],
        "/runs.js": ["run-viewer.js", "text/javascript"],
        "/graph-viewer.js": ["graph-viewer.js", "text/javascript"],
        "/graph-renderer.js": ["graph-renderer.js", "text/javascript"],
        "/graph-renderer.css": ["graph-renderer.css", "text/css"],
        "/dashboard.css": ["dashboard.css", "text/css"],
      };
      const route = routes[request.url ?? ""];
      if (!route) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.setHeader("Content-Type", `${route[1]}; charset=utf-8`);
      response.end(await readFile(new URL(route[0], assets)));
    } catch {
      response.writeHead(503, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error:
            "Could not read coordination data. Check task cards and local board, then retry.",
        }),
      );
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.versions.node !== "26.11.1") throw new Error("Use Node 26.11.1");
  const port = Number(process.env.RELAY_DASHBOARD_PORT ?? "4310");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid RELAY_DASHBOARD_PORT");
  const common = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  const server = createDashboard(dirname(common));
  server.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Coordination dashboard: http://127.0.0.1:${port} (read-only; refreshes every 5s)`,
    ),
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => server.close());
}
