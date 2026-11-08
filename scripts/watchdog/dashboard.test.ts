import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { watchdogHealth } from "./dashboard.ts";
import type { WatchdogInput } from "./policy.ts";
import { settings } from "./runner.ts";
import { checkWatchdog } from "./service.ts";

it("delivers synthetic dead/paused/mismatch faults visibly without controlling live processes", async () => {
  const store = await mkdtemp(join(tmpdir(), "relay-visible-watchdog-"));
  try {
    let notices = 0;
    const input: WatchdogInput = {
      version: 1,
      now: 900000,
      desiredRunning: true,
      supervisor: {
        pid: 999999,
        alive: "dead",
        heartbeatAt: 0,
        draining: false,
      },
      children: [],
      config: { loaded: "a", disk: "b" },
      queue: [],
      coordinator: { turnStartedAt: null, oldestUnhandledAt: null },
      availableCapacity: null,
      lanePauses: [{ lane: "A", reason: "failure" }],
    };
    await checkWatchdog({
      directory: join(store, "watchdog"),
      readInput: async () => input,
      settings: { ...settings, startupGraceMs: 0 },
      signal: new AbortController().signal,
      notify: async () => {
        notices++;
      },
      requestRecovery: async () => {
        throw Error("Must not restart");
      },
      clock: { now: () => 900000, sleep: async () => {} },
    });
    const health = await watchdogHealth(store, 900000);
    expect(notices).toBe(1);
    expect(health.state).toBe("alert");
    expect(health.codes).toEqual(
      expect.arrayContaining([
        "supervisor-dead",
        "config-mismatch",
        "pause-failure",
      ]),
    );
    await writeFile(
      join(store, "watchdog/latest.json"),
      JSON.stringify({
        checkedAt: 900000,
        nextCheck: 1080000,
        observations: [{ code: "PRIVATE_SENTINEL" }],
      }),
      { mode: 0o600 },
    );
    expect(JSON.stringify(await watchdogHealth(store, 900000))).not.toContain(
      "PRIVATE_SENTINEL",
    );
  } finally {
    await rm(store, { recursive: true, force: true });
  }
});
