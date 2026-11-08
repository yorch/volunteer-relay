import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const lanes = ["A", "B", "C", "D", "E", "F", "R", "V"];
const kinds = ["question", "answer", "update", "handoff", "request"];
function ensure(condition, message) {
  if (!condition) throw new Error(message);
}
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function read(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
async function put(path, value, exclusive = false) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    if (exclusive) await link(temp, path);
    else await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    ensure(
      args[i]?.startsWith("--") && args[i + 1] && !args[i + 1].startsWith("--"),
      "Options require --name value pairs",
    );
    const key = args[i].slice(2);
    ensure(!(key in result), `Duplicate option: ${key}`);
    result[key] = args[i + 1];
  }
  return result;
}
function lane(value) {
  ensure(lanes.includes(value), "Agent/owner must be A, B, C, D, E, F, R or V");
  return value;
}
function task(value) {
  ensure(
    /^P\d-\d{2}$/.test(value ?? ""),
    "Task must be a task-card ID, e.g. P1-01",
  );
  return value;
}
function uuid(value) {
  ensure(/^[a-f0-9-]{36}$/.test(value ?? ""), "Invalid message ID");
  return value;
}
async function text(options) {
  ensure(
    Boolean(options.text) !== Boolean(options.file),
    "Provide exactly one of --text or --file",
  );
  const value = options.file
    ? await readFile(resolve(options.file), "utf8")
    : options.text;
  ensure(
    value.trim().length > 0 && value.length <= 32768,
    "Text must contain 1–32768 characters",
  );
  return value;
}
async function context() {
  ensure(
    !process.env.RELAY_COORD_DIR || isAbsolute(process.env.RELAY_COORD_DIR),
    "RELAY_COORD_DIR must be an absolute shared path",
  );
  const root = await realpath(git(["rev-parse", "--show-toplevel"]));
  const common = await realpath(
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  );
  const store = resolve(
    process.env.RELAY_COORD_DIR || join(dirname(common), ".relay-coordination"),
  );
  return { root, common, store };
}
function taskPath(ctx, id, file) {
  return join(ctx.store, "tasks", task(id), file);
}
async function prepare(ctx) {
  await mkdir(join(ctx.store, "messages"), { recursive: true, mode: 0o700 });
  await mkdir(join(ctx.store, "tasks"), { recursive: true, mode: 0o700 });
  const path = join(ctx.store, "repository.json");
  try {
    await put(path, { schemaVersion: 1, gitCommonDir: ctx.common }, true);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const meta = await read(path);
  ensure(
    meta.schemaVersion === 1 && meta.gitCommonDir === ctx.common,
    "Store belongs to a different Git repository or protocol version",
  );
}
async function messages(ctx) {
  const files = await readdir(join(ctx.store, "messages"));
  return (
    await Promise.all(
      files
        .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
        .map((f) => read(join(ctx.store, "messages", f))),
    )
  ).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}
async function send(ctx, value) {
  const message = {
    schemaVersion: 1,
    id: randomUUID(),
    at: new Date().toISOString(),
    ...value,
  };
  await put(join(ctx.store, "messages", `${message.id}.json`), message, true);
  return message;
}
async function claimed(ctx, id, agent) {
  const assignment = await read(taskPath(ctx, id, "assignment.json"));
  const claim = await read(taskPath(ctx, id, "claim.json"));
  ensure(
    assignment.owner === agent && claim.agent === agent,
    "Task belongs to another lane",
  );
  ensure(
    claim.worktree === ctx.root,
    "Run task status commands from its claimed worktree",
  );
  ensure(
    !(await read(taskPath(ctx, id, "accepted.json"), null)),
    "Task is already accepted",
  );
  return { assignment, claim };
}
function scopePaths(value) {
  ensure(
    Array.isArray(value) && value.length > 0 && value.length <= 64,
    "Scope requires 1–64 paths",
  );
  return [
    ...new Set(
      value.map((path) => {
        ensure(
          typeof path === "string" &&
            path.length > 0 &&
            path.length <= 256 &&
            !/[\\:*?[\]{}\s]/.test(path) &&
            [...path].every(
              (character) =>
                character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
            ) &&
            !isAbsolute(path),
          "Scope paths must be relative paths without backslashes, globs or whitespace",
        );
        const normalized = path.replace(/\/$/, "");
        ensure(
          normalized
            .split("/")
            .every((part) => part && part !== "." && part !== ".."),
          "Scope paths must not contain traversal or empty segments",
        );
        return normalized;
      }),
    ),
  ];
}
async function knownScope(ctx, id) {
  const scope = await read(taskPath(ctx, id, "scope.json"), null);
  ensure(
    scope?.version === 1 && scope.task === id && scope.by === "A",
    `Unknown coordinator scope for ${id}; publish scope before pipelining`,
  );
  return scopePaths(scope.paths);
}
function overlaps(left, right) {
  return left.some((a) =>
    right.some(
      (b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
    ),
  );
}
async function taskEntries(ctx) {
  const result = [];
  for (const id of await readdir(join(ctx.store, "tasks"))) {
    if (!/^P\d-\d{2}$/.test(id)) continue;
    const assignment = await read(taskPath(ctx, id, "assignment.json"), null);
    if (!assignment) continue;
    result.push({
      id,
      assignment,
      claim: await read(taskPath(ctx, id, "claim.json"), null),
      status: await read(taskPath(ctx, id, "status.json"), null),
      accepted: await read(taskPath(ctx, id, "accepted.json"), null),
    });
  }
  return result;
}
async function executionGuard(ctx, id, agent) {
  const state = await read(join(ctx.store, "supervisor", "state.json"), null);
  for (const record of Object.values(state?.records ?? {})) {
    ensure(
      record.lane !== agent ||
        record.status !== "running" ||
        (record.task === id && record.cwd === ctx.root),
      `Lane ${agent} has another running native record; wait for its checkpoint`,
    );
  }
  for (const entry of await taskEntries(ctx)) {
    if (entry.id === id) continue;
    ensure(
      entry.claim?.worktree !== ctx.root,
      `Worktree already claimed by ${entry.id}; preserve frozen resources`,
    );
    if (entry.accepted || entry.assignment.owner !== agent) continue;
    ensure(
      entry.status?.state === "ready",
      `Lane ${agent} already has active task ${entry.id}`,
    );
    ensure(
      !overlaps(await knownScope(ctx, id), await knownScope(ctx, entry.id)),
      `Coordinator scopes overlap with ${entry.id}`,
    );
  }
}
const help = `Harness-neutral local coordination (Node 26.11.1)
  agents init
  agents prompt A|B|C|D|E|F|R|V
  agents assign --agent A --task P1-01 --owner B --ref HEAD --text "Approved slice"
  agents scope --agent A --task P1-01 --paths-json '["packages/example"]'
  agents claim --agent B --task P1-01
  agents status --agent B --task P1-01 --state working|blocked|ready --text "Progress/handoff" [--commit HEAD]
  agents send --agent D --to B|all --kind question|answer|update|handoff|request [--task P2-01] [--reply-to UUID] --text "Message"
  agents inbox --agent B [--unanswered true] [--task P1-01]
  agents board
  agents brief
  agents accept --agent A --task P1-01 --commit HEAD --text "Integration checks" [--strategy ff|rebase|squash --integration-base SHA]
  agents release --agent A --task P1-01 --text "Old session stopped; reason"
Use --file path instead of --text for multiline notes. JSON output except prompt/help.
RELAY_COORD_DIR overrides the shared ignored store. No daemon, auto-merge or auto-execution.`;

export async function main(args = process.argv.slice(2)) {
  ensure(process.versions.node === "26.11.1", "Use Node 26.11.1 on PATH");
  const [command, ...rest] = args;
  if (!command || command === "help") return help;
  if (command === "prompt") {
    const agent = lane(rest[0]);
    const base = new URL("../docs/agents/", import.meta.url);
    if (["R", "V"].includes(agent))
      return readFile(new URL(`prompts/${agent}.md`, base), "utf8");
    return `${await readFile(new URL("BOOTSTRAP.md", base), "utf8")}\n${await readFile(new URL("COMMON.md", base), "utf8")}\n${await readFile(new URL(`prompts/${agent}.md`, base), "utf8")}`;
  }
  const valid = [
    "init",
    "assign",
    "scope",
    "claim",
    "status",
    "send",
    "inbox",
    "board",
    "brief",
    "accept",
    "release",
  ];
  ensure(valid.includes(command), `Unknown command: ${command}`);
  const o = options(rest);
  const ctx = await context();
  await prepare(ctx);
  const lock = join(ctx.store, "board-mutation.lock");
  const mutating = ["scope", "assign", "claim", "status"].includes(command);
  if (mutating) {
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          "Board mutation busy; retry after current command finishes (inspect stale lock before recovery)",
        );
      throw error;
    }
  }
  try {
    return await execute(command, o, ctx);
  } finally {
    if (mutating) await rmdir(lock);
  }
}
async function execute(command, o, ctx) {
  if (command === "init")
    return { store: ctx.store, gitCommonDir: ctx.common, schemaVersion: 1 };
  if (command === "board" || command === "brief") {
    const entries = await readdir(join(ctx.store, "tasks"));
    const tasks = [];
    for (const id of entries.filter((id) => /^P\d-\d{2}$/.test(id)).sort()) {
      const assignment = await read(taskPath(ctx, id, "assignment.json"), null);
      if (!assignment) continue;
      tasks.push({
        task: id,
        assignment,
        claim: await read(taskPath(ctx, id, "claim.json"), null),
        status: await read(taskPath(ctx, id, "status.json"), null),
        accepted: await read(taskPath(ctx, id, "accepted.json"), null),
      });
    }
    const all = await messages(ctx);
    const answered = new Set(
      all.filter((m) => m.kind === "answer").map((m) => m.replyTo),
    );
    if (command === "brief")
      return {
        store: ctx.store,
        tasks: tasks.map((t) => ({
          task: t.task,
          owner: t.assignment.owner,
          state: t.accepted
            ? "accepted"
            : (t.status?.state ?? (t.claim ? "claimed" : "assigned")),
          commit: t.accepted?.commit ?? t.status?.commit ?? null,
        })),
        unanswered: all.filter(
          (m) =>
            ["question", "request"].includes(m.kind) && !answered.has(m.id),
        ),
        recent: all.slice(-5).map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          kind: m.kind,
          task: m.task,
          at: m.at,
        })),
      };
    return {
      store: ctx.store,
      messages: all,
      tasks,
      unanswered: all.filter(
        (m) => ["question", "request"].includes(m.kind) && !answered.has(m.id),
      ),
    };
  }
  const agent = lane(o.agent);
  ensure(
    !["R", "V"].includes(agent) || ["inbox", "send"].includes(command),
    "Verification roles R/V only read the board and send findings",
  );
  if (command === "inbox") {
    const all = await messages(ctx);
    const answered = new Set(
      all.filter((m) => m.kind === "answer").map((m) => m.replyTo),
    );
    if (o.task) task(o.task);
    return all.filter(
      (m) =>
        (m.to === agent || m.to === "all") &&
        (!o.task || m.task === o.task) &&
        (o.unanswered !== "true" ||
          (["question", "request"].includes(m.kind) && !answered.has(m.id))),
    );
  }
  if (command === "send") {
    const to = o.to === "all" ? "all" : lane(o.to);
    ensure(kinds.includes(o.kind), "Unknown message kind");
    if (o.task) task(o.task);
    let messageTask = o.task ?? null;
    if (o.kind === "answer")
      ensure(o["reply-to"], "Answers require --reply-to UUID");
    if (o["reply-to"]) {
      const parent = await read(
        join(ctx.store, "messages", `${uuid(o["reply-to"])}.json`),
      );
      ensure(
        !messageTask || !parent.task || messageTask === parent.task,
        "Reply task must match the question/request",
      );
      messageTask ??= parent.task;
      ensure(to === parent.from, "Reply to the original sender");
      ensure(
        parent.to === agent || parent.to === "all",
        "Message was addressed to another lane",
      );
      if (o.kind === "answer")
        ensure(
          ["question", "request"].includes(parent.kind),
          "Answers must reference a question/request",
        );
    }
    return send(ctx, {
      from: agent,
      to,
      kind: o.kind,
      task: messageTask,
      replyTo: o["reply-to"] ?? null,
      text: await text(o),
    });
  }
  const id = task(o.task);
  if (command === "scope") {
    ensure(agent === "A", "Only coordinator A publishes scope");
    const paths = scopePaths(JSON.parse(o["paths-json"]));
    // Amendments cannot make existing same-lane pipelined submissions overlap.
    const entries = await taskEntries(ctx);
    const own = entries.find((entry) => entry.id === id);
    if (own && !own.accepted) {
      for (const entry of entries) {
        if (
          entry.id === id ||
          entry.accepted ||
          entry.assignment.owner !== own.assignment.owner
        )
          continue;
        ensure(
          !overlaps(paths, await knownScope(ctx, entry.id)),
          `Coordinator scopes overlap with ${entry.id}`,
        );
      }
    }
    const scope = {
      version: 1,
      task: id,
      paths,
      at: new Date().toISOString(),
      by: "A",
    };
    await put(taskPath(ctx, id, "scope.json"), scope);
    return scope;
  }
  if (command === "assign") {
    ensure(agent === "A", "Only coordinator A assigns tasks");
    const owner = lane(o.owner);
    ensure(
      !["R", "V"].includes(owner),
      "Send R/V a pinned verification request; do not assign implementation ownership",
    );
    ensure(o.ref, "Assignment requires an approved --ref commit");
    const baseCommit = git(
      ["rev-parse", "--verify", `${o.ref}^{commit}`],
      ctx.root,
    );
    const primaryHead = git(["rev-parse", "HEAD"], dirname(ctx.common));
    try {
      git(["merge-base", "--is-ancestor", baseCommit, primaryHead], ctx.root);
    } catch {
      throw new Error("Assignment base must be primary HEAD or its ancestor");
    }
    const card = git(["show", `${baseCommit}:docs/tasks/${id}.md`], ctx.root);
    const cardOwner = card.match(/Owner(?: lane)?: ([A-F])\b/);
    ensure(
      cardOwner?.[1] === owner,
      "Owner does not match the committed task card",
    );
    for (const entry of await taskEntries(ctx)) {
      if (entry.id === id || entry.assignment.owner !== owner || entry.accepted)
        continue;
      ensure(
        entry.status?.state === "ready",
        `Lane ${owner} already has active task ${entry.id}`,
      );
      ensure(
        !overlaps(await knownScope(ctx, id), await knownScope(ctx, entry.id)),
        `Coordinator scopes overlap with ${entry.id}`,
      );
    }
    const assignment = {
      task: id,
      owner,
      baseCommit,
      at: new Date().toISOString(),
      text: await text(o),
    };
    await put(taskPath(ctx, id, "assignment.json"), assignment, true);
    return assignment;
  }
  const assignment = await read(taskPath(ctx, id, "assignment.json"));
  if (command === "claim") {
    ensure(agent === assignment.owner, "Assigned to another lane");
    ensure(
      agent === "A" || ctx.root !== dirname(ctx.common),
      "Workers must use isolated linked worktrees, not the primary checkout",
    );
    git(
      ["merge-base", "--is-ancestor", assignment.baseCommit, "HEAD"],
      ctx.root,
    );
    await executionGuard(ctx, id, agent);
    const branch = git(["branch", "--show-current"], ctx.root);
    ensure(branch, "Claim requires a named branch");
    const claim = {
      agent,
      task: id,
      worktree: ctx.root,
      branch,
      at: new Date().toISOString(),
    };
    await put(taskPath(ctx, id, "claim.json"), claim, true);
    return claim;
  }
  if (command === "release") {
    ensure(agent === "A", "Only A releases abandoned work");
    ensure(
      !(await read(taskPath(ctx, id, "accepted.json"), null)),
      "Accepted work needs a new task, not release",
    );
    const note = await text(o);
    const archive = join(ctx.store, "archive", `${id}-${randomUUID()}`);
    await mkdir(dirname(archive), { recursive: true, mode: 0o700 });
    await rename(dirname(taskPath(ctx, id, "assignment.json")), archive);
    await send(ctx, {
      from: agent,
      to: "all",
      kind: "update",
      task: id,
      replyTo: null,
      text: `Released task; prior state archived at ${archive}. ${note}`,
    });
    return { archive };
  }
  if (command === "accept") {
    ensure(agent === "A", "Only A accepts integration");
    const status = await read(taskPath(ctx, id, "status.json"));
    ensure(
      status.state === "ready" && status.commit,
      "Task must be ready with a handoff commit",
    );
    ensure(o.commit, "Acceptance requires --commit integration-SHA");
    const commit = git(
      ["rev-parse", "--verify", `${o.commit}^{commit}`],
      ctx.root,
    );
    ensure(
      commit === git(["rev-parse", "HEAD"], ctx.root),
      "Accept current integration HEAD only",
    );
    const strategy = o.strategy || "ff";
    ensure(
      ["ff", "rebase", "squash"].includes(strategy),
      "Unknown integration strategy",
    );
    ensure(
      strategy === "ff" || o["integration-base"],
      "Rewritten integration requires --integration-base before integration",
    );
    const integrationBase = git(
      [
        "rev-parse",
        "--verify",
        `${o["integration-base"] || assignment.baseCommit}^{commit}`,
      ],
      ctx.root,
    );
    git(
      ["merge-base", "--is-ancestor", assignment.baseCommit, integrationBase],
      ctx.root,
    );
    git(["merge-base", "--is-ancestor", integrationBase, commit], ctx.root);
    ensure(
      git(
        ["rev-list", "--merges", `${integrationBase}..${commit}`],
        ctx.root,
      ) === "",
      "Integration must not introduce merge commits",
    );
    if (strategy === "ff") {
      git(["merge-base", "--is-ancestor", status.commit, commit], ctx.root);
    } else {
      const sourceBase = git(
        ["merge-base", status.commit, integrationBase],
        ctx.root,
      );
      const diff = (base, tip) =>
        git(
          [
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            base,
            tip,
            "--",
          ],
          ctx.root,
        );
      const sourceDiff = diff(sourceBase, status.commit);
      ensure(
        sourceDiff && sourceDiff === diff(integrationBase, commit),
        "Integrated changes differ from ready handoff; refresh and review handoff",
      );
      if (strategy === "squash")
        ensure(
          git(
            ["rev-list", "--count", `${integrationBase}..${commit}`],
            ctx.root,
          ) === "1",
          "Squash integration requires one resulting commit",
        );
    }
    ensure(
      git(["status", "--porcelain"], ctx.root) === "",
      "Integration worktree must be clean",
    );
    const accepted = {
      agent,
      task: id,
      commit,
      sourceCommit: status.commit,
      strategy,
      integrationBase,
      at: new Date().toISOString(),
      text: await text(o),
    };
    await put(taskPath(ctx, id, "accepted.json"), accepted, true);
    return accepted;
  }
  ensure(command === "status", "Unknown task action");
  await claimed(ctx, id, agent);
  ensure(
    ["working", "blocked", "ready"].includes(o.state),
    "State must be working, blocked or ready",
  );
  if (o.state === "working") await executionGuard(ctx, id, agent);
  let commit = null;
  if (o.state === "ready") {
    ensure(o.commit, "Ready requires --commit HEAD (or exact SHA)");
    commit = git(["rev-parse", "--verify", `${o.commit}^{commit}`], ctx.root);
    ensure(
      commit === git(["rev-parse", "HEAD"], ctx.root),
      "Ready commit must be current worktree HEAD",
    );
    ensure(
      git(["status", "--porcelain"], ctx.root) === "",
      "Commit or remove task-local changes before ready",
    );
  }
  const status = {
    agent,
    task: id,
    state: o.state,
    commit,
    at: new Date().toISOString(),
    text: await text(o),
  };
  const event = await send(ctx, {
    from: agent,
    to: "A",
    kind: o.state === "ready" ? "handoff" : "update",
    task: id,
    replyTo: null,
    text: status.text,
    state: status.state,
    commit,
  });
  await put(taskPath(ctx, id, "status.json"), {
    ...status,
    messageId: event.id,
  });
  return status;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await main();
    console.log(
      typeof result === "string" ? result : JSON.stringify(result, null, 2),
    );
  } catch (error) {
    console.error(
      `agents: ${error.code === "EEXIST" ? "Record already exists; inspect board/claim before retrying" : error.message}`,
    );
    process.exitCode = 1;
  }
}
