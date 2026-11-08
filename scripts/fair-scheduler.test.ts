import { describe, expect, it } from "vitest";
import {
  evaluateSchedule,
  type Metadata,
  type ScheduleCandidate,
  type ScheduleInput,
  type ScheduleTask,
} from "./fair-scheduler.ts";

function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture");
  return value;
}
const metadata = (patch: Partial<Metadata> = {}): Metadata => ({
  version: 1,
  priority: "normal",
  dependsOn: [],
  reviewOf: null,
  enqueuedAt: 0,
  updatedBy: "A",
  ...patch,
});
const task = (id: string, patch: Partial<ScheduleTask> = {}): ScheduleTask => ({
  id,
  state: "assigned",
  readyCommit: null,
  acceptedCommit: null,
  acceptedSourceCommit: null,
  metadata: null,
  ...patch,
});
const candidate = (
  key: string,
  lane = key,
  patch: Partial<ScheduleCandidate> = {},
): ScheduleCandidate => ({
  key,
  lane,
  taskId: key,
  kind: "implementation",
  enqueuedAt: 0,
  authorized: true,
  phaseAllowed: true,
  ownershipValid: true,
  pathsDisjoint: true,
  acceptedBase: true,
  configLoaded: true,
  blocksAcceptance: false,
  ...patch,
});
const fixture = (
  candidates = [candidate("one")],
  tasks = candidates.map((c) => task(c.taskId)),
): ScheduleInput => ({
  version: 1,
  now: 0,
  maxParallel: 4,
  coordinatorReserved: false,
  active: [],
  lanes: [...new Set([...candidates.map((c) => c.lane), "A"])].map((lane) => ({
    lane,
    enabled: true,
    held: false,
    failurePaused: false,
    runsLastHour: 0,
    maxRunsPerHour: 20,
  })),
  tasks,
  candidates,
});
const reason = (i: ScheduleInput, key: string) =>
  evaluateSchedule(i).queue.find((r) => r.key === key)?.reason;
describe("FAIR-V1 independent deterministic fixtures", () => {
  it("uses persisted FIFO then ASCII, independent of input ordering and restart", () => {
    const i = fixture([candidate("z"), candidate("b"), candidate("a")]);
    expect(evaluateSchedule(i).selected).toEqual(["a", "b", "z"]);
    i.candidates.reverse();
    i.tasks.reverse();
    expect(evaluateSchedule(structuredClone(i)).selected).toEqual([
      "a",
      "b",
      "z",
    ]);
    must(i.candidates[0]).enqueuedAt = 1;
    expect(evaluateSchedule(i).selected).toEqual(["b", "z", "a"]);
  });
  it("ranks explicit urgency above bounded age and review", () => {
    const i = fixture(
      [candidate("aged"), candidate("urgent")],
      [
        task("aged", { metadata: metadata({ priority: "low" }) }),
        task("urgent", {
          metadata: metadata({
            priority: "urgent-operational",
            enqueuedAt: 7200000,
          }),
        }),
      ],
    );
    i.now = 7200000;
    expect(evaluateSchedule(i).selected).toEqual(["urgent", "aged"]);
    expect(evaluateSchedule(i).queue[1]?.components.aging).toBe(2);
  });
  it("pins ready evidence and distinguishes accepted commit from accepted source", () => {
    const i = fixture(
      [candidate("consumer")],
      [
        task("consumer", {
          metadata: metadata({
            dependsOn: [{ taskId: "source", require: "ready", commit: "tip" }],
          }),
        }),
        task("source", { state: "ready", readyCommit: "tip" }),
      ],
    );
    expect(evaluateSchedule(i).selected).toEqual(["consumer"]);
    must(i.tasks[1]).state = "accepted";
    must(i.tasks[1]).acceptedCommit = "integrated";
    expect(reason(i, "consumer")).toBe("DEPENDENCY_WAITING");
    must(i.tasks[1]).acceptedSourceCommit = "tip";
    expect(evaluateSchedule(i).selected).toEqual(["consumer"]);
    must(must(must(i.tasks[0]).metadata).dependsOn[0]).require = "accepted";
    expect(evaluateSchedule(i).selected).toEqual(["consumer"]);
    must(i.tasks[1]).state = "ready";
    expect(reason(i, "consumer")).toBe("DEPENDENCY_WAITING");
    must(must(must(i.tasks[0]).metadata).dependsOn[0]).require = "ready";
    must(must(must(i.tasks[0]).metadata).dependsOn[0]).commit = null;
    expect(reason(i, "consumer")).toBe("DEPENDENCY_WAITING");
  });
  it("contains missing references and cycles to affected candidates", () => {
    const i = fixture(
      [candidate("a"), candidate("b"), candidate("free")],
      [
        task("a", {
          metadata: metadata({
            dependsOn: [{ taskId: "b", require: "accepted", commit: null }],
          }),
        }),
        task("b", {
          metadata: metadata({
            dependsOn: [{ taskId: "a", require: "accepted", commit: null }],
          }),
        }),
        task("free"),
      ],
    );
    expect(evaluateSchedule(i).selected).toEqual(["free"]);
    expect(reason(i, "a")).toBe("DEPENDENCY_CYCLE");
    must(must(must(i.tasks[1]).metadata).dependsOn[0]).taskId = "missing";
    expect(reason(i, "a")).toBe("DEPENDENCY_MISSING");
  });
  it("selects new assigned work beside frozen ready and routes required revision first", () => {
    const i = fixture(
      [candidate("old", "C"), candidate("new", "C")],
      [task("old", { state: "ready", readyCommit: "frozen" }), task("new")],
    );
    const before = structuredClone(i);
    expect(evaluateSchedule(i).selected).toEqual(["new"]);
    expect(i).toEqual(before);
    must(i.candidates[0]).kind = "revision";
    expect(evaluateSchedule(i).selected).toEqual(["old"]);
    expect(reason(i, "new")).toBe("REVISION_PENDING");
    i.active = [{ key: "new", lane: "C" }];
    expect(evaluateSchedule(i).selected).toEqual([]);
  });
  it.each([
    "authorized",
    "phaseAllowed",
    "ownershipValid",
    "pathsDisjoint",
    "acceptedBase",
    "configLoaded",
  ] as const)("fails closed on %s", (field) => {
    const i = fixture();
    must(i.candidates[0])[field] = false;
    expect(evaluateSchedule(i).selected).toEqual([]);
    expect(evaluateSchedule(i).queue[0]?.status).toBe("blocked");
  });
  it("honors aggregate lane budget across task candidates and explicit holds", () => {
    const i = fixture([candidate("old", "C"), candidate("new", "C")]);
    must(i.lanes[0]).runsLastHour = 20;
    expect(evaluateSchedule(i).queue.map((r) => r.reason)).toEqual([
      "RATE_LIMITED",
      "RATE_LIMITED",
    ]);
    must(i.lanes[0]).runsLastHour = 0;
    must(i.lanes[0]).held = true;
    expect(reason(i, "old")).toBe("LANE_HELD");
    must(i.lanes[0]).held = false;
    must(i.lanes[0]).failurePaused = true;
    expect(reason(i, "old")).toBe("FAILURE_PAUSED");
    must(i.lanes[0]).failurePaused = false;
    must(i.lanes[0]).enabled = false;
    expect(reason(i, "old")).toBe("LANE_DISABLED");
  });
  it("reserves A capacity, never exceeds four, and admits control", () => {
    const i = fixture(
      ["B", "C", "D", "E", "A"].map((k) =>
        candidate(k, k, k === "A" ? { kind: "control" } : {}),
      ),
    );
    i.coordinatorReserved = true;
    expect(evaluateSchedule(i).selected).toEqual(["A", "B", "C", "D"]);
    i.candidates = i.candidates.filter((c) => c.lane !== "A");
    expect(evaluateSchedule(i).selected).toEqual(["B", "C", "D"]);
    expect(reason(i, "E")).toBe("COORDINATOR_RESERVED");
    i.active = [{ key: "control", lane: "A" }];
    expect(evaluateSchedule(i).selected).toEqual(["B", "C", "D"]);
  });
  it("gives pinned acceptance review gate priority and FIFO rather than lane order", () => {
    const i = fixture(
      [
        candidate("work", "B"),
        candidate("review", "V", { kind: "review", blocksAcceptance: true }),
      ],
      [
        task("work"),
        task("review", {
          metadata: metadata({ reviewOf: { taskId: "target", commit: "tip" } }),
        }),
        task("target", { state: "ready", readyCommit: "tip" }),
      ],
    );
    i.active = [
      { key: "x", lane: "X" },
      { key: "y", lane: "Y" },
      { key: "z", lane: "Z" },
    ];
    expect(evaluateSchedule(i).selected).toEqual(["review"]);
    must(must(must(i.tasks[1]).metadata).reviewOf).commit = "wrong";
    expect(reason(i, "review")).toBe("REVIEW_PIN_INVALID");
  });
  it("ranks graph-provable accepted unblocks without inferring prose", () => {
    const i = fixture(
      [candidate("a"), candidate("z")],
      [
        task("a"),
        task("z"),
        task("dependent", {
          metadata: metadata({
            dependsOn: [{ taskId: "z", require: "accepted", commit: null }],
          }),
        }),
      ],
    );
    expect(evaluateSchedule(i).selected).toEqual(["z", "a"]);
  });
  it.each(["blocked", "ready", "accepted"] as const)(
    "freezes %s implementation",
    (state) => {
      const i = fixture();
      must(i.tasks[0]).state = state;
      expect(reason(i, "one")).toBe("TASK_FROZEN");
    },
  );
  it("bounds capacity with active work and never selects two candidates on one lane", () => {
    const i = fixture([
      candidate("a", "C"),
      candidate("b", "C"),
      candidate("d", "D"),
    ]);
    i.active = [
      { key: "x", lane: "X" },
      { key: "y", lane: "Y" },
      { key: "z", lane: "Z" },
    ];
    expect(evaluateSchedule(i).selected).toEqual(["a"]);
    expect(reason(i, "b")).toBe("LANE_SELECTED");
    expect(reason(i, "d")).toBe("CAPACITY");
  });
  it("handles a shared dependency graph without mutating caller input", () => {
    const tasks = [task("root", { state: "accepted", acceptedCommit: "base" })];
    for (let n = 0; n < 30; n++)
      tasks.push(
        task(`node${n}`, {
          state: "accepted",
          acceptedCommit: "base",
          metadata: metadata({
            dependsOn: tasks.slice(-2).map((t) => ({
              taskId: t.id,
              require: "accepted" as const,
              commit: "base",
            })),
          }),
        }),
      );
    const i = fixture([candidate("node29", "C", { kind: "control" })], tasks);
    const copy = structuredClone(i);
    expect(evaluateSchedule(i).selected).toEqual(["node29"]);
    expect(i).toEqual(copy);
  });
  it.each([
    null,
    [],
    {},
    { version: 9 },
    { ...fixture(), maxParallel: 5 },
    { ...fixture(), now: NaN },
    {
      ...fixture(),
      tasks: [
        task("x", {
          metadata: {
            ...metadata(),
            updatedBy: "worker",
          } as unknown as Metadata,
        }),
      ],
    },
  ])("rejects malformed input with fixed non-sensitive error", (value) => {
    expect(() => evaluateSchedule(value as ScheduleInput)).toThrow(
      "INVALID_SCHEDULE_INPUT",
    );
  });
});
