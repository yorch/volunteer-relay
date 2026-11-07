import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const script = fileURLToPath(new URL("./agents.mjs", import.meta.url));
const env = { ...process.env, RELAY_COORD_DIR: "" };
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function cli(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: result.status, output: result.stdout, error: result.stderr };
}
function ok(cwd: string, ...args: string[]) {
  const result = cli(cwd, ...args);
  expect(result.error).toBe("");
  expect(result.code).toBe(0);
  return JSON.parse(result.output);
}
function race(
  cwd: string,
  ...args: string[]
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
async function fixture(
  test: (f: {
    root: string;
    b: string;
    b2: string;
    dir: string;
  }) => void | Promise<void>,
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "relay-coord-test-")));
  const root = join(dir, "repo"),
    b = join(dir, "B"),
    b2 = join(dir, "B2");
  try {
    mkdirSync(join(root, "docs/tasks"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".relay-coordination/\n");
    writeFileSync(
      join(root, "docs/tasks/P1-01.md"),
      "Owner lane: B.\nAllowed paths: example/**.\n",
    );
    writeFileSync(
      join(root, "docs/tasks/P1-02.md"),
      "Owner lane: B.\nAllowed paths: example/**.\n",
    );
    git(root, "init", "-q", "--initial-branch=main");
    git(root, "config", "user.name", "Synthetic Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture baseline");
    git(root, "worktree", "add", "-qb", "worker-B", b);
    git(root, "worktree", "add", "-qb", "worker-B2", b2);
    await test({ root, b, b2, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function assign(root: string) {
  return ok(
    root,
    "assign",
    "--agent",
    "A",
    "--task",
    "P1-01",
    "--owner",
    "B",
    "--ref",
    "HEAD",
    "--text",
    "Synthetic scoped assignment",
  );
}
const claim = ["claim", "--agent", "B", "--task", "P1-01"];
const ready = [
  "status",
  "--agent",
  "B",
  "--task",
  "P1-01",
  "--state",
  "ready",
  "--commit",
  "HEAD",
  "--text",
  "Synthetic handoff: checks recorded",
];
const accept = [
  "accept",
  "--agent",
  "A",
  "--task",
  "P1-01",
  "--commit",
  "HEAD",
  "--text",
  "Synthetic integration checks",
];

it("shares a board across linked worktrees and allows exactly one concurrent claim", async () => {
  await fixture(async ({ root, b, b2 }) => {
    expect(ok(root, "init").store).toBe(ok(b, "init").store);
    assign(root);
    const results = await Promise.all([race(b, ...claim), race(b2, ...claim)]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    const board = ok(root, "board");
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "A",
        "--task",
        "P1-02",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "No parallel task for B",
      ).code,
    ).toBe(1);
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0].claim.agent).toBe("B");
    expect([b, b2]).toContain(board.tasks[0].claim.worktree);
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "A",
        "--task",
        "P1-01",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "No overwrite",
      ).code,
    ).toBe(1);
  });
});
it("threads cross-lane questions without executing their content", async () => {
  await fixture(({ root, b }) => {
    const question = ok(
      root,
      "send",
      "--agent",
      "D",
      "--to",
      "B",
      "--kind",
      "question",
      "--task",
      "P1-01",
      "--text",
      "Do not execute $(touch SENTINEL); contract question only",
    );
    expect(ok(b, "inbox", "--agent", "B", "--unanswered", "true")).toHaveLength(
      1,
    );
    expect(
      cli(
        root,
        "send",
        "--agent",
        "E",
        "--to",
        "D",
        "--kind",
        "answer",
        "--reply-to",
        question.id,
        "--text",
        "Wrong recipient",
      ).code,
    ).toBe(1);
    ok(
      b,
      "send",
      "--agent",
      "B",
      "--to",
      "D",
      "--kind",
      "answer",
      "--reply-to",
      question.id,
      "--text",
      "Proposal for A to review",
    );
    expect(ok(root, "inbox", "--agent", "D")[0].replyTo).toBe(question.id);
    expect(ok(root, "inbox", "--agent", "D", "--task", "P1-01")).toHaveLength(
      1,
    );
    expect(ok(root, "board").unanswered).toHaveLength(0);
    expect(
      cli(
        root,
        "send",
        "--agent",
        "B",
        "--to",
        "D",
        "--kind",
        "answer",
        "--text",
        "Missing thread",
      ).code,
    ).toBe(1);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
it("enforces lane/worktree ownership, clean handoff and integration ancestry", async () => {
  await fixture(({ root, b, b2 }) => {
    expect(
      cli(
        root,
        "assign",
        "--agent",
        "D",
        "--task",
        "P1-01",
        "--owner",
        "B",
        "--ref",
        "HEAD",
        "--text",
        "Wrong owner",
      ).code,
    ).toBe(1);
    assign(root);
    expect(cli(root, ...claim).code).toBe(1);
    ok(b, ...claim);
    expect(
      cli(
        b2,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--state",
        "working",
        "--text",
        "Wrong worktree",
      ).code,
    ).toBe(1);
    expect(cli(root, ...accept).code).toBe(1);
    writeFileSync(join(b, "example.txt"), "Synthetic change\n");
    expect(cli(b, ...ready).code).toBe(1);
    git(b, "add", "example.txt");
    git(b, "commit", "-qm", "synthetic task slice");
    const handoff = ok(b, ...ready);
    expect(cli(root, ...accept).code).toBe(1);
    git(root, "merge", "--ff-only", handoff.commit);
    expect(ok(root, ...accept).commit).toBe(handoff.commit);
    expect(
      cli(
        b,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--state",
        "working",
        "--text",
        "Already accepted",
      ).code,
    ).toBe(1);
  });
});
it("archives an abandoned task before reassignment and rejects its old worktree", async () => {
  await fixture(({ root, b, b2 }) => {
    assign(root);
    ok(b, ...claim);
    const released = ok(
      root,
      "release",
      "--agent",
      "A",
      "--task",
      "P1-01",
      "--text",
      "Test session stopped; preserved old branch",
    );
    expect(
      JSON.parse(readFileSync(join(released.archive, "claim.json"), "utf8"))
        .worktree,
    ).toBe(b);
    assign(root);
    ok(b2, ...claim);
    expect(
      cli(
        b,
        "status",
        "--agent",
        "B",
        "--task",
        "P1-01",
        "--state",
        "working",
        "--text",
        "Obsolete writer",
      ).code,
    ).toBe(1);
    expect(ok(root, "board").tasks[0].claim.worktree).toBe(b2);
  });
});
it("provides all six full prompts and supports multiline files without shell interpolation", async () => {
  await fixture(({ root, dir }) => {
    for (const agent of ["A", "B", "C", "D", "E", "F"]) {
      const prompt = cli(root, "prompt", agent);
      expect(prompt.code).toBe(0);
      expect(prompt.output).toContain("Worker self-service setup");
      expect(prompt.output).toContain("Shared agent operating prompt");
      expect(prompt.output).toContain(`Lane ${agent}`);
    }
    const note = join(dir, "note.md");
    writeFileSync(note, "Line one\nLiteral `command` and $(substitution)\n");
    const result = ok(
      root,
      "send",
      "--agent",
      "A",
      "--to",
      "all",
      "--kind",
      "update",
      "--file",
      note,
    );
    expect(result.text).toBe(readFileSync(note, "utf8"));
    expect(cli(root, "claim", "--agent", "B", "--task", "../bad").code).toBe(1);
    unlinkSync(note);
  });
});

it.each(["squash", "rebase"])(
  "records equivalent %s integration and rejects unrelated changes",
  async (strategy) => {
    await fixture(({ root, b }) => {
      assign(root);
      ok(b, ...claim);
      writeFileSync(join(b, "example.txt"), "Synthetic source change\n");
      git(b, "add", ".");
      git(b, "commit", "-qm", "feat(test): add synthetic source");
      const source = ok(b, ...ready).commit;
      writeFileSync(join(root, "other.txt"), "Concurrent coordinator change\n");
      git(root, "add", ".");
      git(root, "commit", "-qm", "chore(test): add coordinator change");
      const base = git(root, "rev-parse", "HEAD");
      const options = ["--strategy", strategy, "--integration-base", base];
      expect(cli(root, ...accept, ...options).code).toBe(1);
      if (strategy === "squash") {
        git(root, "merge", "--squash", source);
        git(root, "commit", "-qm", "feat(test): integrate synthetic source");
      } else {
        git(root, "cherry-pick", source);
      }
      expect(cli(root, ...accept).code).toBe(1);
      const accepted = ok(root, ...accept, ...options);
      expect(accepted.sourceCommit).toBe(source);
      expect(accepted.strategy).toBe(strategy);
      expect(accepted.integrationBase).toBe(base);
      expect(accepted.commit).not.toBe(source);
    });
  },
);

it("rejects merge commits even when handoff ancestry is preserved", async () => {
  await fixture(({ root, b }) => {
    const base = assign(root).baseCommit;
    ok(b, ...claim);
    writeFileSync(join(b, "example.txt"), "Synthetic source change\n");
    git(b, "add", ".");
    git(b, "commit", "-qm", "feat(test): add synthetic source");
    const source = ok(b, ...ready).commit;
    git(root, "merge", "--no-ff", "-m", "Synthetic forbidden merge", source);
    const result = cli(root, ...accept, "--integration-base", base);
    expect(result.code).toBe(1);
    expect(result.error).toContain("must not introduce merge commits");
  });
});
