import { execFileSync, spawnSync } from "node:child_process";
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
const policy = JSON.parse(
  readFileSync(join(project, "crewplane.json"), "utf8"),
);
const binary = process.env.CREWPLANE_TEST_BIN || "crewplane";
const env = {
  ...process.env,
  RELAY_COORD_DIR: "",
  CREWPLANE_COORD_DIR: "",
  CREWPLANE_NO_AUTO_UPDATE: "1",
};
it("uses the native version and prompt policy through the real linked-worktree workflow", () => {
  expect(
    execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim(),
  ).toBe(policy.requiredVersion);
  const outer = realpathSync(
      mkdtempSync(join(tmpdir(), "relay-native-crewplane-")),
    ),
    root = join(outer, "project # with spaces"),
    worker = join(outer, "worker");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const call = (cwd: string, ...args: string[]) =>
    execFileSync(binary, ["--project", cwd, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  const json = (cwd: string, ...args: string[]) =>
    JSON.parse(call(cwd, ...args));
  try {
    mkdirSync(root);
    mkdirSync(join(root, "docs/tasks"), { recursive: true });
    mkdirSync(join(root, "docs/agents/prompts"), { recursive: true });
    for (const file of new Set(
      Object.values(policy.promptFiles).flat() as string[],
    ))
      copyFileSync(join(project, file), join(root, file));
    writeFileSync(join(root, "crewplane.json"), JSON.stringify(policy));
    writeFileSync(
      join(root, "AGENTS.md"),
      "Synthetic native policy fixture; no harness activation.\n",
    );
    writeFileSync(
      join(root, "docs/tasks/P8-01.md"),
      "# P8-01 — Synthetic task\nOwner: B.\nGoal: bounded native integration\n",
    );
    writeFileSync(
      join(root, ".gitignore"),
      ".crewplane-state/\n.crewplane-local/\n.relay-coordination/\n",
    );
    mkdirSync(join(root, ".relay-coordination"));
    writeFileSync(
      join(root, ".relay-coordination/sentinel"),
      "LEGACY_STATE_RETAINED",
    );
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "user.name", "Synthetic");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "add", ".");
    git(root, "commit", "-qm", "test: native project fixture");
    const base = git(root, "rev-parse", "HEAD");
    const initialized = json(root, "init");
    expect(initialized.running).toBe(false);
    expect(initialized.store).toBe(join(root, ".crewplane-state"));
    expect(json(root, "status")).toEqual({ desired: null, state: null });
    json(
      root,
      "agents",
      "scope",
      "--agent",
      "A",
      "--task",
      "P8-01",
      "--paths-json",
      '["feature.txt"]',
    );
    json(
      root,
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
      "Synthetic scoped assignment",
    );
    git(root, "worktree", "add", "-qb", "worker", worker, base);
    writeFileSync(
      join(worker, "docs/agents/BOOTSTRAP.md"),
      "STALE_WORKER_PROMPT",
    );
    const prompt = call(worker, "agents", "prompt", "B");
    expect(prompt).toContain("Worker self-service setup");
    expect(prompt).toContain(
      readFileSync(join(project, "docs/agents/prompts/B.md"), "utf8").trimEnd(),
    );
    expect(prompt).not.toContain("STALE_WORKER_PROMPT");
    const reviewPrompt = call(worker, "agents", "prompt", "R");
    expect(reviewPrompt).toContain("Verification-only reviewer");
    expect(reviewPrompt).not.toContain(
      "--- Project instructions: docs/agents/BOOTSTRAP.md",
    );
    git(worker, "restore", "docs/agents/BOOTSTRAP.md");
    json(worker, "agents", "claim", "--agent", "B", "--task", "P8-01");
    const q = json(
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
      "Synthetic scope question",
    );
    json(
      root,
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
    expect(json(worker, "agents", "board").unanswered).toEqual([]);
    writeFileSync(join(worker, "feature.txt"), "Synthetic change\n");
    git(worker, "add", "feature.txt");
    git(worker, "commit", "-qm", "feat: synthetic scoped change");
    const ready = git(worker, "rev-parse", "HEAD");
    json(
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
      "Synthetic checks passed",
    );
    const frozen = spawnSync(
      binary,
      [
        "--project",
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
        "Unpinned reopen",
      ],
      { env },
    );
    expect(frozen.status).not.toBe(0);
    const review = json(
      root,
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
      "Review pinned synthetic tip",
    );
    json(
      root,
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
      "Synthetic review complete",
    );
    git(root, "merge", "--ff-only", ready);
    json(
      root,
      "agents",
      "accept",
      "--agent",
      "A",
      "--task",
      "P8-01",
      "--commit",
      ready,
      "--text",
      "Verified linear integration",
    );
    expect(json(root, "agents", "board").tasks[0].accepted.commit).toBe(ready);
    expect(git(root, "rev-list", "--merges", `${base}..HEAD`)).toBe("");
    expect(
      readFileSync(join(root, ".relay-coordination/sentinel"), "utf8"),
    ).toBe("LEGACY_STATE_RETAINED");
    expect(existsSync(join(initialized.store, "supervisor/config.json"))).toBe(
      false,
    );
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
}, 30000);
