import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const project = fileURLToPath(new URL("../", import.meta.url));
const env = { ...process.env, RELAY_COORD_DIR: "", CREWPLANE_COORD_DIR: "" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
function fixture() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "relay-crewplane-"))),
    root = join(outer, "project with # spaces");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "docs/tasks"), { recursive: true });
  mkdirSync(join(root, "docs/agents/prompts"), { recursive: true });
  for (const file of [
    "scripts/crewplane.mjs",
    "scripts/agents.mjs",
    "crewplane.json",
    ".crewplane-version",
  ])
    copyFileSync(join(project, file), join(root, file));
  writeFileSync(
    join(root, ".gitignore"),
    ".crewplane-state/\n.crewplane-local/\n.relay-coordination/\n",
  );
  writeFileSync(
    join(root, "AGENTS.md"),
    "Synthetic project only; no harness execution.\n",
  );
  writeFileSync(
    join(root, "docs/tasks/P8-01.md"),
    "# P8-01 — Synthetic adoption\nOwner: B.\nGoal: isolated task workflow\n",
  );
  for (const [name, text] of [
    ["BOOTSTRAP.md", "PRIMARY_BOOTSTRAP"],
    ["COMMON.md", "PRIMARY_COMMON"],
    ["prompts/B.md", "PRIMARY_B"],
    ["prompts/R.md", "PRIMARY_REVIEWER"],
  ])
    writeFileSync(join(root, "docs/agents", name as string), text as string);
  mkdirSync(join(root, ".relay-coordination"));
  writeFileSync(
    join(root, ".relay-coordination/preserved.json"),
    "PREVIOUS_STATE_MUST_NOT_CHANGE",
  );
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.name", "Synthetic");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "test: synthetic adoption baseline");
  const launcher = join(root, "scripts/crewplane.mjs");
  const call = (cwd: string, ...args: string[]) =>
    execFileSync(process.execPath, [launcher, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const json = (cwd: string, ...args: string[]) =>
    JSON.parse(call(cwd, ...args));
  return { outer, root, launcher, call, json };
}
it("integrates the installed release across worktrees with pinned review and frozen linear acceptance", () => {
  const f = fixture();
  try {
    const initial = f.json(f.root, "init");
    expect(initial.running).toBe(false);
    expect(initial.store).toBe(join(f.root, ".crewplane-state"));
    expect(f.json(f.root, "status")).toEqual({ desired: null, state: null });
    expect(f.json(f.root, "doctor").config).toBe("not-configured");
    f.json(
      f.root,
      "agents",
      "scope",
      "--agent",
      "A",
      "--task",
      "P8-01",
      "--paths-json",
      '["feature.txt"]',
    );
    const base = git(f.root, "rev-parse", "HEAD");
    f.json(
      f.root,
      "agents",
      "assign",
      "--agent",
      "A",
      "--task",
      "P8-01",
      "--owner",
      "B",
      "--ref",
      base,
      "--text",
      "Synthetic approved slice",
    );
    const worker = join(f.outer, "worker");
    git(f.root, "worktree", "add", "-qb", "worker", worker, base);
    expect(f.json(worker, "agents", "init").store).toBe(initial.store);
    const supervised = spawnSync(
      process.execPath,
      [f.launcher, "agents", "board"],
      {
        cwd: worker,
        env: { ...env, CREWPLANE_COORD_DIR: initial.store },
        encoding: "utf8",
      },
    );
    expect(supervised.status).toBe(0);
    expect(JSON.parse(supervised.stdout).store).toBe(initial.store);
    writeFileSync(
      join(worker, "docs/agents/BOOTSTRAP.md"),
      "STALE_WORKER_PROMPT",
    );
    expect(f.call(worker, "agents", "prompt", "B")).toContain(
      "PRIMARY_BOOTSTRAP",
    );
    expect(f.call(worker, "agents", "prompt", "B")).not.toContain(
      "STALE_WORKER_PROMPT",
    );
    expect(f.call(worker, "agents", "prompt", "R")).toBe("PRIMARY_REVIEWER");
    git(worker, "restore", "docs/agents/BOOTSTRAP.md");
    f.json(worker, "agents", "claim", "--agent", "B", "--task", "P8-01");
    const q = f.json(
      worker,
      "agents",
      "send",
      "--agent",
      "B",
      "--to",
      "A",
      "--kind",
      "question",
      "--task",
      "P8-01",
      "--text",
      "Synthetic contract question",
    );
    f.json(
      f.root,
      "agents",
      "send",
      "--agent",
      "A",
      "--to",
      "B",
      "--kind",
      "answer",
      "--reply-to",
      q.id,
      "--text",
      "Synthetic scoped answer",
    );
    expect(f.json(worker, "agents", "board").unanswered).toEqual([]);
    writeFileSync(join(worker, "feature.txt"), "Synthetic implementation\n");
    git(worker, "add", "feature.txt");
    git(worker, "commit", "-qm", "feat: synthetic bounded change");
    const ready = git(worker, "rev-parse", "HEAD");
    f.json(
      worker,
      "agents",
      "status",
      "--agent",
      "B",
      "--task",
      "P8-01",
      "--state",
      "ready",
      "--commit",
      ready,
      "--text",
      "Synthetic verification complete",
    );
    expect(() =>
      f.call(
        worker,
        "agents",
        "status",
        "--agent",
        "B",
        "--task",
        "P8-01",
        "--state",
        "working",
        "--text",
        "Unauthorized reopen",
      ),
    ).toThrow();
    const review = f.json(
      f.root,
      "agents",
      "send",
      "--agent",
      "A",
      "--to",
      "R",
      "--kind",
      "request",
      "--task",
      "P8-01",
      "--commit",
      ready,
      "--text",
      "Review exact synthetic tip",
    );
    f.json(
      f.root,
      "agents",
      "send",
      "--agent",
      "R",
      "--to",
      "A",
      "--kind",
      "answer",
      "--reply-to",
      review.id,
      "--text",
      "Synthetic review passed",
    );
    git(f.root, "merge", "--ff-only", ready);
    f.json(
      f.root,
      "agents",
      "accept",
      "--agent",
      "A",
      "--task",
      "P8-01",
      "--commit",
      ready,
      "--text",
      "Reviewed and integrated synthetic slice",
    );
    expect(f.json(f.root, "agents", "board").tasks[0].accepted.commit).toBe(
      ready,
    );
    expect(git(f.root, "rev-list", "--merges", `${base}..HEAD`)).toBe("");
    expect(
      readFileSync(join(f.root, ".relay-coordination/preserved.json"), "utf8"),
    ).toBe("PREVIOUS_STATE_MUST_NOT_CHANGE");
    expect(existsSync(join(initial.store, "supervisor/config.json"))).toBe(
      false,
    );
    expect(existsSync(join(initial.store, "supervisor/desired.json"))).toBe(
      false,
    );
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
}, 30000);
it("fails closed for missing/mismatched binaries and legacy store overrides", () => {
  const f = fixture();
  try {
    const fake = join(f.outer, "wrong-version");
    writeFileSync(fake, `#!${process.execPath}\nconsole.log('999.0.0');\n`, {
      mode: 0o700,
    });
    for (const [extra, expected] of [
      [{ CREWPLANE_BIN: "/nonexistent/crewplane" }, "is required"],
      [{ CREWPLANE_BIN: fake }, "version mismatch"],
      [
        { RELAY_COORD_DIR: join(f.root, ".relay-coordination") },
        "Unset RELAY_COORD_DIR",
      ],
      [
        { CREWPLANE_COORD_DIR: join(f.root, ".relay-coordination") },
        "Unset CREWPLANE_COORD_DIR",
      ],
    ] as const) {
      const r = spawnSync(process.execPath, [f.launcher, "init"], {
        cwd: f.root,
        env: { ...env, ...extra },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(expected);
      expect(existsSync(join(f.root, ".crewplane-state"))).toBe(false);
    }
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("preserves child exit codes and forwards shutdown while waiting for settlement", async () => {
  const f = fixture();
  try {
    const fake = join(f.outer, "controlled-cli"),
      marker = join(f.outer, "settled");
    writeFileSync(
      fake,
      `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('0.2.0');}else if(process.argv.includes('exit-fixture'))process.exit(7);else if(process.argv.includes('kill-fixture'))process.kill(process.pid,'SIGKILL');else{console.log('ready');process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'settled');process.exit(0)},80));setInterval(()=>{},1000);}\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(process.execPath, [f.launcher, "exit-fixture"], {
      cwd: f.root,
      env: { ...env, CREWPLANE_BIN: fake },
    });
    expect(result.status).toBe(7);
    const killed = spawnSync(process.execPath, [f.launcher, "kill-fixture"], {
      cwd: f.root,
      env: { ...env, CREWPLANE_BIN: fake },
    });
    expect(killed.status).toBe(137);
    const child = spawn(process.execPath, [f.launcher, "signal-fixture"], {
      cwd: f.root,
      env: { ...env, CREWPLANE_BIN: fake },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("exit", done);
    });
    try {
      await new Promise<void>((done, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Controlled CLI startup timed out")),
          5000,
        );
        child.stdout.once("data", () => {
          clearTimeout(timeout);
          done();
        });
      });
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("settled");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited;
    }
  } finally {
    rmSync(f.outer, { recursive: true, force: true });
  }
});
it("keeps Relay roles and execution template inert and outside product dependencies", () => {
  const policy = JSON.parse(
    readFileSync(join(project, "crewplane.json"), "utf8"),
  );
  expect(policy).toMatchObject({
    coordinator: "A",
    reviewerRoles: { R: "code", V: "visual" },
    tasksPath: "docs/tasks",
    instructionsPath: "AGENTS.md",
  });
  const template = JSON.parse(
    readFileSync(
      join(project, "docs/agents/crewplane-runtime.example.json"),
      "utf8",
    ),
  );
  expect(template.allowedTasks).toEqual([]);
  expect(
    Object.values(template.lanes).every(
      (lane) => !(lane as { enabled: boolean }).enabled,
    ),
  ).toBe(true);
  expect(Number.isFinite(Date.parse(template.confirmedStoppedAt))).toBe(false);
  const manifest = JSON.parse(
    readFileSync(join(project, "package.json"), "utf8"),
  );
  expect(manifest.dependencies?.crewplane).toBeUndefined();
  expect(manifest.devDependencies?.crewplane).toBeUndefined();
});
