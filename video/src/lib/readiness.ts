import type { Timeline } from "./timeline.ts";

/**
 * Final-render readiness gate. Shared by the renderer (which refuses a final
 * render) and the validator (which reports the same problems), so a silent,
 * scratch-voiced or partially captured programme can never be published as the
 * finished video.
 */

export interface FinalReadinessInput {
  timeline: Timeline;
  productScenes: readonly string[];
  capturedSceneIds: readonly string[];
  captureOrigins: readonly string[];
  cueCount: number;
  hasMusic: boolean;
}

export function finalRenderProblems(input: FinalReadinessInput): string[] {
  const problems: string[] = [];
  if (input.timeline.narrationSource === "scratch-local-voice")
    problems.push(
      "narration is the local scratch voice; generate real narration or supply audio",
    );
  if (input.timeline.narrationSource === "absent")
    problems.push("no narration audio is present");
  const missing = input.productScenes.filter(
    (sceneId) => !input.capturedSceneIds.includes(sceneId),
  );
  if (missing.length)
    problems.push(`missing captures for ${missing.join(", ")}`);
  if (input.cueCount === 0) problems.push("no captions were derived");
  const origins = new Set(input.captureOrigins);
  if (origins.size > 1)
    problems.push(
      `mixed capture origins (${[...origins].join(", ")}); one delivery must come from one release`,
    );
  if (input.cueCount > 0 && input.timeline.totalSeconds <= 0)
    problems.push("timeline has no duration");
  return problems;
}
