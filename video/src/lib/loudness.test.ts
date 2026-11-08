import { describe, expect, it } from "vitest";
import {
  gainForTarget,
  limiterCeiling,
  MAX_GAIN_DB,
  needsLimiter,
  programmeLoudness,
  TARGET_LUFS,
} from "./loudness.ts";

const scene = (
  sceneId: string,
  durationSeconds: number,
  integratedLufs: number | null,
  truePeakDb: number | null,
) => ({ sceneId, durationSeconds, integratedLufs, truePeakDb });

describe("programme loudness", () => {
  it("weights scenes by duration", () => {
    const quietLong = programmeLoudness([
      scene("S01", 30, -24, -6),
      scene("S02", 10, -14, -3),
    ]);
    expect(quietLong).toBeCloseTo(
      10 * Math.log10((30 * 10 ** -2.4 + 10 * 10 ** -1.4) / 40),
      5,
    );
  });

  it("ignores silent scenes instead of treating them as zero", () => {
    expect(
      programmeLoudness([
        scene("S01", 10, -20, -6),
        scene("S02", 10, null, null),
      ]),
    ).toBeCloseTo(-20, 5);
    expect(programmeLoudness([scene("S01", 10, null, null)])).toBeNull();
    expect(programmeLoudness([])).toBeNull();
  });
});

describe("mix gain", () => {
  it("moves the programme to the target", () => {
    expect(gainForTarget(-22.9)).toBeCloseTo(TARGET_LUFS + 22.9, 5);
  });

  it("clamps extreme corrections and stays neutral for silence", () => {
    expect(gainForTarget(-60)).toBe(MAX_GAIN_DB);
    expect(gainForTarget(0)).toBe(-MAX_GAIN_DB);
    expect(gainForTarget(null)).toBe(0);
  });
});

describe("true-peak limiting", () => {
  it("asks for a limiter only when the gain would clip", () => {
    expect(needsLimiter([scene("S01", 10, -22, -10)], 6)).toBe(false);
    expect(needsLimiter([scene("S01", 10, -22, -4)], 7)).toBe(true);
    expect(needsLimiter([scene("S01", 10, -22, null)], 30)).toBe(false);
  });

  it("converts the ceiling to the linear value ffmpeg expects", () => {
    expect(limiterCeiling()).toBeCloseTo(0.8913, 4);
    expect(limiterCeiling(-6)).toBeCloseTo(0.5012, 4);
  });
});
