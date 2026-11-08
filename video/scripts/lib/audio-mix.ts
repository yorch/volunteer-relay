import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, log, run } from "../../src/lib/cli.ts";
import { paths } from "../../src/lib/env.ts";
import {
  gainForTarget,
  limiterCeiling,
  needsLimiter,
  programmeLoudness,
  type SceneLoudness,
  TARGET_LUFS,
} from "../../src/lib/loudness.ts";
import { measureLoudness } from "../../src/lib/probe.ts";
import { type NarrationManifest, narrationFile } from "./assets.ts";

/**
 * Narration loudness normalisation for the mix. One gain is computed for the
 * whole programme (duration-weighted EBU R128) so relative performance between
 * scenes is preserved; when the gain would exceed the true-peak ceiling a
 * limiter is inserted. Normalised files live beside the originals and never
 * replace them.
 */

export const MIX_DIR = join(paths.generated, "narration-mix");

export interface NarrationMix {
  /** Public-directory relative paths for the composition. */
  files: Record<string, string>;
  /** Mean per-scene gain, for reporting. */
  gainDb: number;
  gainRangeDb: [number, number];
  limited: boolean;
  programmeLufs: number | null;
}

export function mixNarration(manifest: NarrationManifest): NarrationMix {
  const measurements: SceneLoudness[] = manifest.scenes.map((asset) => {
    const measured = measureLoudness(narrationFile(asset.sceneId));
    return {
      sceneId: asset.sceneId,
      durationSeconds: asset.durationSeconds,
      integratedLufs: measured.integratedLufs,
      truePeakDb: measured.truePeakDb,
    };
  });
  const programme = programmeLoudness(measurements);
  ensureDir(MIX_DIR);

  // Per-scene gain keeps any excerpt (proof, single scene) on target while the
  // programme still averages to the same target.
  const files: Record<string, string> = {};
  const gains: number[] = [];
  let limited = false;
  for (const [index, asset] of manifest.scenes.entries()) {
    const measurement = measurements[index];
    const gainDb = gainForTarget(measurement?.integratedLufs ?? null);
    const needsLimit = needsLimiter(measurement ? [measurement] : [], gainDb);
    if (needsLimit) limited = true;
    gains.push(gainDb);
    const source = narrationFile(asset.sceneId);
    const target = join(MIX_DIR, `${asset.sceneId}.mp3`);
    const stale =
      !existsSync(target) ||
      statSync(target).mtimeMs < statSync(source).mtimeMs;
    if (stale) {
      const filters = [
        `volume=${gainDb.toFixed(2)}dB`,
        ...(needsLimit
          ? [`alimiter=limit=${limiterCeiling().toFixed(4)}:level=false`]
          : []),
      ];
      const result = run("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        source,
        "-af",
        filters.join(","),
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "192k",
        target,
      ]);
      if (result.status !== 0)
        throw new Error(
          `Narration normalisation failed for ${asset.sceneId}: ${result.stderr.trim()}`,
        );
      log(
        `  ${asset.sceneId}: mix gain ${gainDb.toFixed(1)} dB${needsLimit ? " + limiter" : ""}`,
      );
    }
    files[asset.sceneId] = `narration-mix/${asset.sceneId}.mp3`;
  }
  const min = Math.min(...gains);
  const max = Math.max(...gains);
  return {
    files,
    gainDb:
      gains.reduce((sum, value) => sum + value, 0) / Math.max(1, gains.length),
    gainRangeDb: [min, max],
    limited,
    programmeLufs: programme,
  };
}

export const targetLufs = TARGET_LUFS;
