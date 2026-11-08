import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readHealth, settings } from "./runner.ts";
import { checkWatchdog } from "./service.ts";

it("projects private health without raw notices, tolerates missing config and checks notice-only", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-health-input-"));
  try {
    await mkdir(join(store, "supervisor"), { mode: 0o700 });
    const now = Date.now();
    await writeFile(
      join(store, "supervisor/state.json"),
      JSON.stringify({
        pid: process.pid,
        running: true,
        checkedAt: new Date(now).toISOString(),
        held: [],
        notices: { A: ["PRIVATE_SENTINEL"] },
        records: {
          a: {
            lane: "A",
            status: "running",
            pid: process.pid,
            startedAt: new Date(now).toISOString(),
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(store, "supervisor/desired.json"),
      JSON.stringify({ desiredRunning: false }),
      { mode: 0o600 },
    );
    const input = await readHealth(store, now);
    expect(input.supervisor.alive).toBe("alive");
    expect(input.children).toEqual([{ pid: process.pid, alive: "alive" }]);
    expect(input.desiredRunning).toBe(false);
    expect(input.config).toEqual({ loaded: null, disk: null });
    expect(input.coordinator.oldestUnhandledAt).toBeNull();
    expect(JSON.stringify(input)).not.toContain("PRIVATE_SENTINEL");
    let recoveryCalls = 0;
    const result = await checkWatchdog({
      directory: join(store, "watchdog"),
      settings,
      signal: new AbortController().signal,
      readInput: async () => input,
      notify: async () => {},
      requestRecovery: async () => {
        recoveryCalls++;
      },
    });
    expect(result?.recovery).toBe("none");
    expect(recoveryCalls).toBe(0);
    const persisted = JSON.parse(
      await readFile(join(store, "watchdog/latest.json"), "utf8"),
    );
    expect(persisted.nextCheck - persisted.checkedAt).toBe(180000);
    await writeFile(join(store, "supervisor/state.json"), "{PRIVATE_SENTINEL", {
      mode: 0o600,
    });
    const missing = await readHealth(store, now);
    expect(missing.supervisor.alive).toBe("unknown");
    expect(missing.children).toEqual([]);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
