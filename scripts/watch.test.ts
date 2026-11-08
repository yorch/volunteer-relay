import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { monitorStatus, type snapshot } from "./dashboard.ts";
import { acquire, poll, run, summarize } from "./watch.ts";

const settings = {
  intervalSeconds: 30,
  staleMinutes: 20,
  unansweredMinutes: 5,
};
const time = new Date("2026-11-07T12:30:00Z");
it("distinguishes unanswered/stale/blocked/review/unclaimed observations without changing ownership", () => {
  const task = (
    id: string,
    state: string | null,
    claim = true,
    accepted = false,
  ) => ({
    id,
    live: {
      assignment: { owner: "B", at: "2026-11-07T12:00:00Z" },
      claim: claim ? {} : null,
      status: state ? { state, at: "2026-11-07T12:00:00Z" } : null,
      accepted: accepted ? {} : null,
    },
  });
  const data = {
    tasks: [
      task("P1-01", "working"),
      task("P1-02", "blocked"),
      task("P1-03", "ready"),
      task("P1-04", null, false),
      task("P1-05", "working", true, true),
    ],
    messages: [{ id: "m" }],
    unanswered: [
      {
        id: "m",
        to: "A",
        from: "B",
        kind: "question",
        task: "P1-01",
        at: "2026-11-07T12:00:00Z",
      },
    ],
    milestoneStatus: "M1 open",
  };
  const original = JSON.stringify(data);
  const result = summarize(
    data as unknown as Awaited<ReturnType<typeof snapshot>>,
    settings,
    time,
  );
  expect(result.alerts.map((a) => a.kind)).toEqual([
    "stale",
    "blocked",
    "review",
    "unclaimed",
    "overdue-answer",
  ]);
  expect(result.activeTasks).toHaveLength(4);
  expect(result.alerts.find((a) => a.kind === "review")?.agent).toBe("A");
  expect(JSON.stringify(data)).toBe(original);
});

it("shares one lock, safely recovers a dead owner and does not release a successor's lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-watch-lock-"));
  try {
    const release = await acquire(directory);
    await expect(acquire(directory)).rejects.toThrow("already owns");
    await release();
    const deadPid = Number(
      execFileSync(process.execPath, ["-e", "console.log(process.pid)"], {
        encoding: "utf8",
      }),
    );
    await writeFile(
      join(directory, "watcher.lock"),
      JSON.stringify({ pid: deadPid, token: "dead" }),
    );
    const releaseRecovered = await acquire(directory);
    await writeFile(
      join(directory, "watcher.lock"),
      JSON.stringify({ pid: process.pid, token: "successor" }),
    );
    await releaseRecovered();
    expect(
      JSON.parse(await readFile(join(directory, "watcher.lock"), "utf8")).token,
    ).toBe("successor");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("records changes once, recovers read errors and stops cleanly without board writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-watch-board-"));
  const oldStore = process.env.RELAY_COORD_DIR;
  process.env.RELAY_COORD_DIR = "";
  const cli = fileURLToPath(new URL("./agents.mjs", import.meta.url));
  const command = (...args: string[]) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, RELAY_COORD_DIR: "" },
      encoding: "utf8",
    });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    await mkdir(join(root, "docs/tasks"), { recursive: true });
    await writeFile(join(root, "docs/STATUS.md"), "M0 complete; M1 open");
    await writeFile(
      join(root, "docs/tasks/P1-01.md"),
      "# P1-01 — Synthetic\nOwner lane: B. Status: queued\n",
    );
    git("init", "-q", "--initial-branch=main");
    git("config", "user.name", "Synthetic Test");
    git("config", "user.email", "test@example.invalid");
    git("add", ".");
    git("commit", "-qm", "test: prepare watcher fixture");
    const { store } = JSON.parse(command("init"));
    const directory = join(store, "monitor");
    const release = await acquire(directory);
    expect((await poll(root, directory, settings, time)).changed).toBe(true);
    expect(
      (await poll(root, directory, settings, new Date(time.getTime() + 30000)))
        .changed,
    ).toBe(false);
    expect(await readdir(join(directory, "events"))).toHaveLength(1);
    const question = JSON.parse(
      command(
        "send",
        "--agent",
        "B",
        "--to",
        "A",
        "--kind",
        "question",
        "--text",
        "Synthetic question $(never execute)",
      ),
    );
    const changed = await poll(root, directory, settings, new Date());
    expect(changed.changed).toBe(true);
    expect(changed.observation.messageCount).toBe(1);
    expect(changed.observation.alerts[0]?.kind).toBe("needs-answer");
    const events = await readdir(join(directory, "events"));
    const newest = JSON.parse(
      await readFile(
        join(directory, "events", events.sort().at(-1) ?? ""),
        "utf8",
      ),
    );
    expect(newest.newMessageIds).toEqual([question.id]);
    expect(JSON.stringify(newest)).not.toContain("never execute");
    expect((await stat(join(directory, "latest.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect((await monitorStatus(store)).state).toBe("running");
    expect(
      (await monitorStatus(store, new Date(Date.now() + 120000))).state,
    ).toBe("stale");
    command(
      "send",
      "--agent",
      "A",
      "--to",
      "B",
      "--kind",
      "answer",
      "--reply-to",
      question.id,
      "--text",
      "Synthetic answer",
    );
    expect((await poll(root, directory)).observation.unansweredCount).toBe(0);
    await release();
    await run(root, directory, settings, true, new AbortController().signal);
    expect((await monitorStatus(store)).state).toBe("stopped");
    expect(await readdir(directory)).not.toContain("watcher.lock");
    const controller = new AbortController();
    const watching = run(
      root,
      directory,
      { ...settings, intervalSeconds: 1 },
      false,
      controller.signal,
    );
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (!(await check())) {
        if (Date.now() > deadline)
          throw new Error("Watcher transition timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    try {
      await until(async () => (await monitorStatus(store)).state === "running");
      await rename(
        join(root, "docs/STATUS.md"),
        join(root, "docs/STATUS.backup"),
      );
      await until(async () => (await monitorStatus(store)).state === "error");
      await rename(
        join(root, "docs/STATUS.backup"),
        join(root, "docs/STATUS.md"),
      );
      await until(async () => (await monitorStatus(store)).state === "running");
    } finally {
      controller.abort();
      await watching;
    }
    expect((await monitorStatus(store)).state).toBe("stopped");
    expect(await readdir(directory)).not.toContain("watcher.lock");
    const board = JSON.parse(command("board"));
    expect(board.messages).toHaveLength(2);
    expect(board.tasks).toEqual([]);
    expect(board.unanswered).toEqual([]);
  } finally {
    if (oldStore === undefined) delete process.env.RELAY_COORD_DIR;
    else process.env.RELAY_COORD_DIR = oldStore;
    await rm(root, { recursive: true, force: true });
  }
  // Spawns node and git subprocesses; the 5s default is not enough under a
  // full parallel run, where this test has timed out twice.
}, 30_000);
