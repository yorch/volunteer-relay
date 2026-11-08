import scenesJson from "../../scenes.json";
import type { AccentCue } from "./accents.ts";
import { type Cue, cueSchema } from "./captions.ts";
import { type Box, parseSceneManifest } from "./schema.ts";
import { buildTimeline, type Timeline } from "./timeline.ts";

/**
 * Props shared by Studio preview, proof renders and the final render.
 * The index signature satisfies Remotion's `Record<string, unknown>` component
 * constraint; scripts build the object from validated manifests.
 */
export interface HackathonVideoProps extends Record<string, unknown> {
  timeline: Timeline;
  mode: "full" | "proof";
  assets: {
    narration: boolean;
    captures: boolean;
    captions: boolean;
    music: boolean;
  };
  /** Public-directory relative media paths, keyed by scene id. */
  captureFiles: Record<string, string>;
  narrationFiles: Record<string, string>;
  /** Absolute programme-time captions derived from alignment. */
  cues: Cue[];
  musicFile: string | null;
  /** Shown per product scene so footage origin is never ambiguous. */
  captureOrigins: Record<string, "hosted" | "local">;
  /** Recorded element boxes per scene, used by spotlight annotations. */
  captureRegions: Record<string, Record<string, Box>>;
  /** Sparse UI accents placed on real action markers. */
  accents: AccentCue[];
  accentFiles: { click: string; confirm: string } | null;
}

export function nominalProps(): HackathonVideoProps {
  const manifest = parseSceneManifest(scenesJson);
  const timeline = buildTimeline(
    manifest,
    manifest.scenes.map((scene) => ({
      id: scene.id,
      kind: scene.kind,
      minSeconds: scene.minSeconds,
      maxSeconds: scene.maxSeconds,
      narrationSeconds: null,
      footageSeconds: null,
      narrationSource: "absent" as const,
    })),
  );
  return {
    timeline,
    mode: "full",
    assets: {
      narration: false,
      captures: false,
      captions: false,
      music: false,
    },
    captureFiles: {},
    narrationFiles: {},
    cues: [],
    musicFile: null,
    captureOrigins: {},
    captureRegions: {},
    accents: [],
    accentFiles: null,
  };
}

export function parseCues(value: unknown): Cue[] {
  if (!Array.isArray(value)) throw new Error("Captions must be an array");
  return value.map((entry, index) => {
    const parsed = cueSchema.safeParse(entry);
    if (!parsed.success)
      throw new Error(
        `Caption ${index + 1} is invalid: ${parsed.error.message}`,
      );
    return parsed.data;
  });
}
