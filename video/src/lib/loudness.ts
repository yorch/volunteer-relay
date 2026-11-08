/**
 * Programme loudness maths for the narration mix. Measurements come from
 * ffmpeg's EBU R128 pass; the gain is computed once for the whole programme so
 * relative performance between scenes is preserved, and a true-peak limit keeps
 * the mix legal after the gain is applied.
 */

export interface SceneLoudness {
  sceneId: string;
  durationSeconds: number;
  integratedLufs: number | null;
  truePeakDb: number | null;
}

export const TARGET_LUFS = -16;
export const MAX_TRUE_PEAK_DB = -1;
export const MAX_GAIN_DB = 12;

/** Duration-weighted programme loudness; silences are ignored, not zeroed. */
export function programmeLoudness(
  measurements: readonly SceneLoudness[],
): number | null {
  let energy = 0;
  let total = 0;
  for (const measurement of measurements) {
    if (measurement.integratedLufs === null) continue;
    const duration = Math.max(0, measurement.durationSeconds);
    if (duration === 0) continue;
    energy += duration * 10 ** (measurement.integratedLufs / 10);
    total += duration;
  }
  if (total === 0 || energy <= 0) return null;
  return 10 * Math.log10(energy / total);
}

export function gainForTarget(
  programme: number | null,
  targetLufs = TARGET_LUFS,
): number {
  if (programme === null) return 0;
  const gain = targetLufs - programme;
  return Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, gain));
}

/** True when the gain would push any scene past the peak ceiling. */
export function needsLimiter(
  measurements: readonly SceneLoudness[],
  gainDb: number,
  ceilingDb = MAX_TRUE_PEAK_DB,
): boolean {
  return measurements.some(
    (measurement) =>
      measurement.truePeakDb !== null &&
      measurement.truePeakDb + gainDb > ceilingDb,
  );
}

/** ffmpeg alimiter takes a linear ceiling; -1 dBTP is about 0.891. */
export function limiterCeiling(ceilingDb = MAX_TRUE_PEAK_DB): number {
  return 10 ** (ceilingDb / 20);
}
