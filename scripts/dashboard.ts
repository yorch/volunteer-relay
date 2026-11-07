import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Message {
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
  task: string;
  assignment: { owner: string; baseCommit: string; at: string; text: string };
  claim: { branch: string; worktree: string; at: string } | null;
  status: {
    state: string;
    text: string;
    at: string;
    commit: string | null;
  } | null;
  accepted: { commit: string; at: string; text: string } | null;
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
        : live?.status?.state === "working" || live?.claim
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

export async function snapshot(root: string) {
  const board: Board = JSON.parse(
    execFileSync(process.execPath, [cli, "board"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
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
  return {
    updatedAt: new Date().toISOString(),
    monitor: await monitorStatus(board.store),
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
      const routes: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/dashboard.js": ["dashboard.js", "text/javascript"],
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
