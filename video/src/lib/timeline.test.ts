import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "./env.ts";
import { parseSceneManifest } from "./schema.ts";
import {
  buildTimeline,
  framesToSeconds,
  parseTimeline,
  type SceneTimingInput,
  sceneDurationFrames,
  secondsToFrames,
  subsetTimeline,
  TAIL_PADDING_SECONDS,
} from "./timeline.ts";

const manifest = parseSceneManifest(
  JSON.parse(readFileSync(paths.scenes, "utf8")),
);

function input(overrides: Partial<SceneTimingInput>): SceneTimingInput {
  return {
    id: "S01",
    kind: "graphic",
    minSeconds: 20,
    maxSeconds: 26,
    narrationSeconds: null,
    footageSeconds: null,
    narrationSource: "absent",
    ...overrides,
  };
}

describe("frame arithmetic", () => {
  it("rounds seconds at one frame boundary", () => {
    expect(secondsToFrames(1, 30)).toBe(30);
    expect(secondsToFrames(0.0166, 30)).toBe(0);
    expect(secondsToFrames(0.0167, 30)).toBe(1);
    expect(framesToSeconds(45, 30)).toBe(1.5);
  });

  it("rejects negative or non-finite conversions", () => {
    expect(() => secondsToFrames(-1, 30)).toThrow();
    expect(() => secondsToFrames(Number.NaN, 30)).toThrow();
    expect(() => framesToSeconds(1.5, 30)).toThrow();
  });

  it("uses the manifest minimum when narration is short", () => {
    expect(sceneDurationFrames(input({ narrationSeconds: 3 }), 30)).toBe(600);
  });

  it("adds the tail padding to narration length", () => {
    const frames = sceneDurationFrames(input({ narrationSeconds: 21 }), 30);
    expect(frames).toBe(Math.ceil((21 + TAIL_PADDING_SECONDS) * 30));
  });

  it("fails loudly instead of speeding up over-long narration", () => {
    expect(() =>
      sceneDurationFrames(input({ narrationSeconds: 26 }), 30),
    ).toThrow(/narration needs/);
  });

  it("rejects inputs that do not cover every scene", () => {
    expect(() =>
      buildTimeline(
        manifest,
        manifest.scenes.slice(1).map((scene) =>
          input({
            id: scene.id,
            minSeconds: scene.minSeconds,
            maxSeconds: scene.maxSeconds,
          }),
        ),
      ),
    ).toThrow(/Timeline inputs must cover every manifest scene/);
  });
});

describe("timeline build", () => {
  const inputs = manifest.scenes.map((scene) =>
    input({
      id: scene.id,
      kind: scene.kind,
      minSeconds: scene.minSeconds,
      maxSeconds: scene.maxSeconds,
      narrationSeconds: scene.minSeconds - 1,
      footageSeconds: scene.minSeconds + 2,
      narrationSource: "elevenlabs",
    }),
  );

  it("produces contiguous integer boundaries", () => {
    const timeline = buildTimeline(manifest, inputs);
    let cursor = 0;
    for (const scene of timeline.scenes) {
      expect(scene.startFrame).toBe(cursor);
      expect(Number.isInteger(scene.durationInFrames)).toBe(true);
      expect(scene.durationInFrames).toBeGreaterThan(0);
      cursor += scene.durationInFrames;
    }
    expect(timeline.totalFrames).toBe(cursor);
    expect(timeline.totalSeconds).toBeCloseTo(cursor / 30, 6);
    expect(timeline.totalSeconds).toBeLessThanOrEqual(manifest.maxSeconds);
  });

  it("rejects footage shorter than a scene", () => {
    const short = inputs.map((entry, index) =>
      index === 3 ? { ...entry, footageSeconds: 4 } : entry,
    );
    expect(() => buildTimeline(manifest, short)).toThrow(/shorter than/);
  });

  it("keeps the programme inside the delivery limit", () => {
    const tooLong = inputs.map((entry) => ({
      ...entry,
      narrationSeconds: entry.maxSeconds - TAIL_PADDING_SECONDS,
      footageSeconds: 120,
    }));
    expect(() => buildTimeline(manifest, tooLong)).toThrow(
      /exceeds the 180s delivery limit/,
    );
  });

  it("round-trips through the timeline schema", () => {
    const timeline = buildTimeline(manifest, inputs);
    expect(parseTimeline(JSON.parse(JSON.stringify(timeline)))).toEqual(
      timeline,
    );
  });

  it("re-bases a single scene for the proof excerpt", () => {
    const timeline = buildTimeline(manifest, inputs);
    const proof = subsetTimeline(timeline, ["S03"], 540);
    expect(proof.scenes).toHaveLength(1);
    expect(proof.scenes[0]?.startFrame).toBe(0);
    expect(proof.totalFrames).toBe(540);
    expect(proof.totalSeconds).toBe(18);
  });
});
