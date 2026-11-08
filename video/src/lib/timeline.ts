import { z } from "zod";
import type { SceneManifest } from "./schema.ts";

/**
 * Frame arithmetic shared by the timeline builder, the composition and the
 * validators. Rules:
 *  - one second is an integer number of frames at the delivery frame rate;
 *  - a scene is at least its manifest minimum and its narration plus tail;
 *  - scene starts are cumulative integers, so boundaries never drift;
 *  - the whole programme must stay inside the delivery limit.
 */

export const TAIL_PADDING_SECONDS = 0.6;

export const narrationSourceSchema = z.enum([
  "elevenlabs",
  "supplied-audio",
  "scratch-local-voice",
  "absent",
]);

export const timelineSceneSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["graphic", "product"]),
    startFrame: z.number().int().nonnegative(),
    durationInFrames: z.number().int().positive(),
    startSeconds: z.number().nonnegative(),
    durationSeconds: z.number().positive(),
    narrationSeconds: z.number().positive().nullable(),
    tailSeconds: z.number().nonnegative(),
    narrationSource: narrationSourceSchema,
    /** Measured length of the captured footage available for this scene. */
    footageSeconds: z.number().positive().nullable(),
  })
  .strict();

export const timelineSchema = z
  .object({
    schemaVersion: z.literal(1),
    fps: z.literal(30),
    width: z.literal(1920),
    height: z.literal(1080),
    totalFrames: z.number().int().positive(),
    totalSeconds: z.number().positive(),
    narrationSource: narrationSourceSchema,
    scenes: z.array(timelineSceneSchema).min(1),
  })
  .strict();

export type NarrationSource = z.infer<typeof narrationSourceSchema>;
export type TimelineScene = z.infer<typeof timelineSceneSchema>;
export type Timeline = z.infer<typeof timelineSchema>;

export function secondsToFrames(seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0)
    throw new Error(`Cannot convert ${seconds} seconds to frames`);
  // Deterministic rounding at the half-frame; callers never round twice.
  return Math.round(seconds * fps);
}

export function framesToSeconds(frames: number, fps: number): number {
  if (!Number.isInteger(frames) || frames < 0)
    throw new Error(`Cannot convert ${frames} frames to seconds`);
  return frames / fps;
}

export interface SceneTimingInput {
  id: string;
  kind: "graphic" | "product";
  minSeconds: number;
  maxSeconds: number;
  narrationSeconds: number | null;
  footageSeconds: number | null;
  narrationSource: NarrationSource;
}

/**
 * Duration rule: `max(minSeconds, narration + tail)`, rounded up to whole
 * frames, then compared with the scene cap. An over-long narration is an error,
 * never a request to speak faster.
 */
export function sceneDurationFrames(
  input: SceneTimingInput,
  fps: number,
  tailSeconds = TAIL_PADDING_SECONDS,
): number {
  const spoken =
    input.narrationSeconds === null ? 0 : input.narrationSeconds + tailSeconds;
  const planned = Math.max(input.minSeconds, spoken);
  if (input.narrationSeconds !== null && planned > input.maxSeconds)
    throw new Error(
      `${input.id}: narration needs ${planned.toFixed(2)}s but the scene cap is ${input.maxSeconds}s. Shorten the narration or raise the cap deliberately.`,
    );
  if (planned > input.maxSeconds) return secondsToFrames(input.maxSeconds, fps);
  const frames = Math.ceil(planned * fps - 1e-9);
  const floorFrames = Math.max(1, secondsToFrames(input.minSeconds, fps));
  return Math.max(frames, floorFrames);
}

export function buildTimeline(
  manifest: SceneManifest,
  inputs: readonly SceneTimingInput[],
): Timeline {
  if (inputs.length !== manifest.scenes.length)
    throw new Error("Timeline inputs must cover every manifest scene");
  const { fps, maxSeconds } = manifest;
  let cursor = 0;
  const scenes: TimelineScene[] = [];
  for (const [index, scene] of manifest.scenes.entries()) {
    const input = inputs[index];
    if (!input || input.id !== scene.id)
      throw new Error(`Timeline input ${index} does not match ${scene.id}`);
    const durationInFrames = sceneDurationFrames(
      { ...input, minSeconds: scene.minSeconds, maxSeconds: scene.maxSeconds },
      fps,
    );
    if (
      input.footageSeconds !== null &&
      input.footageSeconds + 1e-6 < durationInFrames / fps
    )
      throw new Error(
        `${scene.id}: captured footage (${input.footageSeconds.toFixed(2)}s) is shorter than the ${(
          durationInFrames / fps
        ).toFixed(
          2,
        )}s scene. Recapture the scene or extend a static hold; never loop an action.`,
      );
    scenes.push({
      id: scene.id,
      kind: scene.kind,
      startFrame: cursor,
      durationInFrames,
      startSeconds: cursor / fps,
      durationSeconds: durationInFrames / fps,
      narrationSeconds: input.narrationSeconds,
      tailSeconds: input.narrationSeconds === null ? 0 : TAIL_PADDING_SECONDS,
      narrationSource: input.narrationSource,
      footageSeconds: input.footageSeconds,
    });
    cursor += durationInFrames;
  }
  const totalSeconds = cursor / fps;
  if (totalSeconds > maxSeconds + 1e-9)
    throw new Error(
      `Programme runs ${totalSeconds.toFixed(2)}s and exceeds the ${maxSeconds}s delivery limit. Trim holds or narration.`,
    );
  const sources = new Set(scenes.map((scene) => scene.narrationSource));
  const narrationSource: NarrationSource = sources.has("absent")
    ? "absent"
    : sources.has("scratch-local-voice")
      ? "scratch-local-voice"
      : sources.has("supplied-audio")
        ? "supplied-audio"
        : "elevenlabs";
  return {
    schemaVersion: 1,
    fps,
    width: manifest.width,
    height: manifest.height,
    totalFrames: cursor,
    totalSeconds,
    narrationSource,
    scenes,
  };
}

export function parseTimeline(value: unknown): Timeline {
  const result = timelineSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid timeline:\n${result.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  return result.data;
}

/**
 * Re-base a subset of scenes into a standalone timeline (proof segments). The
 * subset keeps integer boundaries and can be capped to a shorter excerpt.
 */
export function subsetTimeline(
  timeline: Timeline,
  sceneIds: readonly string[],
  maxDurationFrames?: number,
): Timeline {
  const selected = sceneIds.map((id) => {
    const scene = timeline.scenes.find((candidate) => candidate.id === id);
    if (!scene) throw new Error(`Unknown timeline scene ${id}`);
    return scene;
  });
  let cursor = 0;
  const scenes: TimelineScene[] = selected.map((scene) => {
    const durationInFrames =
      maxDurationFrames !== undefined &&
      scene.id === selected[selected.length - 1]?.id
        ? Math.min(scene.durationInFrames, maxDurationFrames - cursor)
        : scene.durationInFrames;
    if (durationInFrames <= 0)
      throw new Error(`Proof excerpt has no frames left for ${scene.id}`);
    const rebased: TimelineScene = {
      ...scene,
      startFrame: cursor,
      startSeconds: cursor / timeline.fps,
      durationInFrames,
      durationSeconds: durationInFrames / timeline.fps,
    };
    cursor += durationInFrames;
    return rebased;
  });
  return {
    ...timeline,
    totalFrames: cursor,
    totalSeconds: cursor / timeline.fps,
    scenes,
  };
}

/** Frame of the last scene, used for proof segments and QA stills. */
export function lastScene(timeline: Timeline): TimelineScene {
  const scene = timeline.scenes.at(-1);
  if (!scene) throw new Error("Timeline has no scenes");
  return scene;
}
