import type { Timeline } from "./timeline.ts";

/**
 * Final-render readiness gate. Shared by the renderer (which refuses a final
 * render) and the validator (which reports the same problems).
 *
 * The gate reads the *current* assets, not only the saved timeline: narration is
 * re-checked against the audio on disk, captions must cover every narrated
 * scene, and all footage must come from one origin. A stale timeline therefore
 * cannot smuggle scratch audio or a missing scene into the final render.
 */

export interface CurrentNarrationAsset {
  sceneId: string;
  durationSeconds: number;
  source: string;
}

export interface FinalReadinessInput {
  timeline: Timeline;
  productScenes: readonly string[];
  capturedSceneIds: readonly string[];
  captureOrigins: readonly string[];
  /** Scenes that have audio on disk right now. */
  currentNarration: readonly CurrentNarrationAsset[];
  /** Scenes that produced at least one caption cue. */
  captionedSceneIds: readonly string[];
  hasMusic: boolean;
}

const DURATION_TOLERANCE_SECONDS = 1 / 30;

export function finalRenderProblems(input: FinalReadinessInput): string[] {
  const problems: string[] = [];
  if (!input.hasMusic && input.timeline.narrationSource === "absent")
    problems.push("no narration audio is present");

  const currentById = new Map(
    input.currentNarration.map((asset) => [asset.sceneId, asset]),
  );
  for (const scene of input.timeline.scenes) {
    const asset = currentById.get(scene.id);
    if (!asset) {
      problems.push(`no narration file for ${scene.id}`);
      continue;
    }
    if (asset.source === "scratch-local-voice")
      problems.push(
        `${scene.id} narration is the local scratch voice; generate real narration or supply audio`,
      );
    if (
      scene.narrationSeconds !== null &&
      Math.abs(asset.durationSeconds - scene.narrationSeconds) >
        DURATION_TOLERANCE_SECONDS
    )
      problems.push(
        `${scene.id} narration on disk is ${asset.durationSeconds.toFixed(2)}s but the timeline was built for ${scene.narrationSeconds.toFixed(2)}s; rerun video:timeline`,
      );
  }

  const missingCaptions = input.timeline.scenes
    .filter((scene) => currentById.has(scene.id))
    .filter((scene) => !input.captionedSceneIds.includes(scene.id))
    .map((scene) => scene.id);
  if (missingCaptions.length)
    problems.push(`no captions for ${missingCaptions.join(", ")}`);

  const missing = input.productScenes.filter(
    (sceneId) => !input.capturedSceneIds.includes(sceneId),
  );
  if (missing.length)
    problems.push(`missing captures for ${missing.join(", ")}`);

  const origins = new Set(input.captureOrigins);
  if (origins.size > 1)
    problems.push(
      `mixed capture origins (${[...origins].join(", ")}); one delivery must come from one release`,
    );
  if (input.timeline.totalSeconds <= 0)
    problems.push("timeline has no duration");
  return problems;
}
