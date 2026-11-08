import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTraceStore, nativeTrace } from "./operational-traces.ts";

const run = (n = 1) => `179410000000${n}-00000000-0000-4000-8000-000000000001`;
it("projects both native adapters without collecting reasoning, credentials or arbitrary tool payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-traces-"));
  try {
    const store = await createTraceStore(root);
    const writer = await store.begin({
      runId: run(),
      lane: "A",
      task: "P1-08",
      harness: "codex",
    });
    await writer.emit({ kind: "started" });
    const reasoning = nativeTrace("codex", {
      type: "item.completed",
      item: {
        type: "reasoning",
        text: "PRIVATE_THOUGHT password=synthetic-secret",
      },
    });
    expect(reasoning).toEqual([]);
    for (const event of nativeTrace("codex", {
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "echo AUTHORIZATION=private",
        aggregated_output: "sensitive mail body",
        exit_code: 1,
      },
    }))
      await writer.emit(event);
    for (const event of nativeTrace("pi", {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "PRIVATE_THOUGHT" },
          { type: "text", text: "cookie=private token=secret" },
        ],
        model: "synthetic",
        provider: "fixture",
        thinkingLevel: "high",
        usage: { input: 10, output: 2 },
      },
    }))
      await writer.emit(event);
    await writer.finish("finished", "waiting");
    const tail = await store.tail(run());
    const text = JSON.stringify(tail);
    for (const secret of [
      "PRIVATE_THOUGHT",
      "private",
      "secret",
      "AUTHORIZATION",
      "mail body",
    ])
      expect(text).not.toContain(secret);
    expect(
      tail.events.some(
        (e) => e.kind === "tool-finish" && e.status === "failed",
      ),
    ).toBe(true);
    expect(
      tail.events.some(
        (e) => e.model === "fixture/synthetic" && e.effort === "high",
      ),
    ).toBe(true);
    for (const name of await readdir(root))
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("keeps partial active tails, caps events and prunes bounded finished runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-traces-"));
  try {
    const store = await createTraceStore(root, { maxEvents: 2, maxRuns: 1 });
    const writer = await store.begin({
      runId: run(),
      lane: "V",
      task: "P1-07",
      harness: "pi",
    });
    await writer.emit({ kind: "started" });
    expect((await store.tail(run())).meta.status).toBe("running");
    await writer.emit({ kind: "omitted", channel: "stderr" });
    await writer.emit({ kind: "assistant" });
    await writer.finish("finished", "ready");
    expect((await store.tail(run())).meta.truncated).toBe(true);
    expect((await store.tail(run())).events).toHaveLength(2);
    await store.begin({
      runId: run(2),
      lane: "V",
      task: "P1-07",
      harness: "pi",
    });
    expect((await store.list()).runs.map((r) => r.runId)).toEqual([run(2)]);
    await expect(store.tail(run())).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects traversal/symlink reads and safely reports corrupted/oversize partial input", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-traces-"));
  const foreign = join(tmpdir(), `relay-foreign-${Date.now()}`);
  try {
    const store = await createTraceStore(root);
    await expect(store.tail("../secret")).rejects.toThrow();
    await writeFile(foreign, "never-read-private");
    await symlink(foreign, join(root, `${run()}.meta.json`));
    await expect(store.tail(run())).rejects.toThrow();
    const w = await store.begin({
      runId: run(2),
      lane: "A",
      task: null,
      harness: "codex",
    });
    await w.emit({ kind: "started" });
    const path = join(root, `${run(2)}.events.jsonl`);
    const prior = await readFile(path, "utf8");
    await writeFile(
      path,
      prior +
        '{"partial":\n' +
        JSON.stringify({
          sequence: 2,
          at: new Date().toISOString(),
          kind: "assistant",
          message: "raw-secret",
          model: "sk-private",
        }) +
        "\n" +
        "X".repeat(5000) +
        "\n",
    );
    const tail = await store.tail(run(2));
    expect(tail.incomplete).toBe(true);
    expect(JSON.stringify(tail)).not.toContain("raw-secret");
    expect(JSON.stringify(tail)).not.toContain("sk-private");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { force: true });
  }
});
