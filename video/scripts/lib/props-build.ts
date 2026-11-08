import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { type Cue, cueSchema } from "../../src/lib/captions.ts";
import { paths } from "../../src/lib/env.ts";
import type { HackathonVideoProps } from "../../src/lib/props.ts";
import { productScenes, type SceneManifest } from "../../src/lib/schema.ts";
import type { Timeline } from "../../src/lib/timeline.ts";
import {
  type CaptureManifest,
  capturePublicPath,
  type NarrationManifest,
  narrationPublicPath,
} from "./assets.ts";

export function captionsPath(): string {
  return `${paths.captions}/captions.json`;
}

const cueSetSchema = z
  .object({
    sceneId: z.string(),
    derived: z.enum(["alignment", "proportional-phrase"]),
    cues: z.array(cueSchema),
  })
  .strict();

const captionsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenes: z.array(cueSetSchema),
  })
  .strict();

export type CueSet = z.infer<typeof cueSetSchema>;

export function readCueSets(): CueSet[] {
  if (!existsSync(captionsPath())) return [];
  const parsed = captionsFileSchema.safeParse(
    JSON.parse(readFileSync(captionsPath(), "utf8")),
  );
  if (!parsed.success)
    throw new Error(`Invalid generated captions: ${parsed.error.message}`);
  return parsed.data.scenes;
}

/**
 * Captions are stored per scene so a proof excerpt receives the cue for the
 * scene on screen instead of whatever was spoken at that absolute programme
 * time in the full video.
 */
export function cuesForTimeline(
  timeline: Timeline,
  cueSets: readonly CueSet[],
): Cue[] {
  const cues: Cue[] = [];
  for (const scene of timeline.scenes) {
    const set = cueSets.find((entry) => entry.sceneId === scene.id);
    if (!set) continue;
    const sceneEnd = scene.startSeconds + scene.durationSeconds;
    for (const cue of set.cues) {
      const start = scene.startSeconds + cue.startSeconds;
      const end = Math.min(scene.startSeconds + cue.endSeconds, sceneEnd);
      if (end - start < 0.05) continue;
      cues.push({ startSeconds: start, endSeconds: end, text: cue.text });
    }
  }
  return cues.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Build the props the composition needs. Missing assets are reported as absent
 * instead of silently substituted, so a render cannot pretend to have footage
 * or narration it never had.
 */
export function buildRenderProps(input: {
  manifest: SceneManifest;
  timeline: Timeline;
  captures: CaptureManifest | null;
  narration: NarrationManifest | null;
  mode: "full" | "proof";
}): HackathonVideoProps {
  const captureFiles: Record<string, string> = {};
  const captureOrigins: Record<string, "hosted" | "local"> = {};
  for (const scene of productScenes(input.manifest)) {
    const asset = input.captures?.scenes.find(
      (entry) => entry.sceneId === scene.id,
    );
    if (!asset) continue;
    captureFiles[scene.id] = capturePublicPath(scene.id);
    captureOrigins[scene.id] = asset.origin;
  }
  const narrationFiles: Record<string, string> = {};
  if (input.narration)
    for (const asset of input.narration.scenes)
      narrationFiles[asset.sceneId] = narrationPublicPath(asset.sceneId);
  const cues = cuesForTimeline(input.timeline, readCueSets());
  return {
    timeline: input.timeline,
    mode: input.mode,
    assets: {
      narration: Object.keys(narrationFiles).length > 0,
      captures: Object.keys(captureFiles).length > 0,
      captions: cues.length > 0,
      music: Boolean(process.env.VIDEO_MUSIC_FILE),
    },
    captureFiles,
    narrationFiles,
    cues,
    musicFile: null,
    captureOrigins,
  };
}
