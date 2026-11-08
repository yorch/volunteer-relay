import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  type Cue,
  captionsFromProportionalPhrases,
  captionsFromWords,
  toSrt,
  validateCues,
  wordsFromCharacterAlignment,
} from "../src/lib/captions.ts";
import {
  ensureDir,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
  warn,
  writeJson,
} from "../src/lib/cli.ts";
import { parseAlignment } from "../src/lib/elevenlabs.ts";
import { paths } from "../src/lib/env.ts";
import { parseSceneManifest, type Scene } from "../src/lib/schema.ts";
import {
  buildTimeline,
  type SceneTimingInput,
  subsetTimeline,
} from "../src/lib/timeline.ts";
import {
  alignmentFile,
  type NarrationAsset,
  narrationFile,
  readCaptureManifest,
  readNarrationManifest,
} from "./lib/assets.ts";
import { captionsPath } from "./lib/props-build.ts";

/**
 * Build frame timings from measured assets, then derive captions from provider
 * alignment. Supplied audio without alignment falls back to phrase-level
 * proportional timings, which are labelled rather than presented as aligned.
 */

const PROOF_SCENE = "S03";
const PROOF_MAX_SECONDS = 18;

function captionsFor(
  scene: Scene,
  asset: NarrationAsset,
  offsetSeconds: number,
): { cues: Cue[]; derived: "alignment" | "proportional-phrase" } {
  // Provider alignment describes one specific audio file. Supplied or scratch
  // audio carries no alignment, so stale provider timings are never reused.
  if (asset.source === "elevenlabs" && existsSync(alignmentFile(scene.id))) {
    const alignment = parseAlignment(
      JSON.parse(readFileSync(alignmentFile(scene.id), "utf8")),
    );
    const words = wordsFromCharacterAlignment({
      characters: alignment.characters,
      startSeconds: alignment.character_start_times_seconds,
      endSeconds: alignment.character_end_times_seconds,
    });
    return {
      cues: captionsFromWords(words, offsetSeconds),
      derived: "alignment",
    };
  }
  return {
    cues: captionsFromProportionalPhrases(
      scene.narration,
      asset.durationSeconds,
      offsetSeconds,
    ),
    derived: "proportional-phrase",
  };
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const manifest = parseSceneManifest(
    JSON.parse(readFileSync(paths.scenes, "utf8")),
  );
  const narration = readNarrationManifest();
  const captures = readCaptureManifest();
  const allowSilence = Boolean(args.flags["allow-silence"]);

  const inputs: SceneTimingInput[] = manifest.scenes.map((scene) => {
    const asset = narration?.scenes.find((entry) => entry.sceneId === scene.id);
    const capture = captures?.scenes.find(
      (entry) => entry.sceneId === scene.id,
    );
    if (!asset && !allowSilence)
      throw new Error(
        `Missing narration for ${scene.id}. Run bun run video:voice (or pass --allow-silence for a silent composition check).`,
      );
    if (scene.kind === "product" && !capture && !allowSilence)
      throw new Error(
        `Missing capture for ${scene.id}. Run bun run video:capture first.`,
      );
    return {
      id: scene.id,
      kind: scene.kind,
      minSeconds: scene.minSeconds,
      maxSeconds: scene.maxSeconds,
      narrationSeconds: asset?.durationSeconds ?? null,
      footageSeconds: capture?.durationSeconds ?? null,
      narrationSource: asset?.source ?? "absent",
    };
  });

  const timeline = buildTimeline(manifest, inputs);
  ensureDir(paths.generated);
  writeJson(paths.timeline, timeline);

  const cueSets: Array<{
    sceneId: string;
    derived: "alignment" | "proportional-phrase";
    cues: Cue[];
  }> = [];
  const absoluteCues: Cue[] = [];
  const derivations: string[] = [];
  for (const [index, scene] of manifest.scenes.entries()) {
    const asset = narration?.scenes.find((entry) => entry.sceneId === scene.id);
    const timelineScene = timeline.scenes[index];
    if (!asset || !timelineScene || !existsSync(narrationFile(scene.id))) {
      derivations.push(`${scene.id}: no narration`);
      continue;
    }
    const result = captionsFor(scene, asset, 0);
    cueSets.push({
      sceneId: scene.id,
      derived: result.derived,
      cues: result.cues,
    });
    for (const cue of result.cues)
      absoluteCues.push({
        startSeconds: timelineScene.startSeconds + cue.startSeconds,
        endSeconds: timelineScene.startSeconds + cue.endSeconds,
        text: cue.text,
      });
    derivations.push(
      `${scene.id}: ${result.cues.length} cues (${result.derived})`,
    );
    const problems = validateCues(result.cues, timelineScene.durationSeconds);
    if (problems.length) warn(`${scene.id} captions: ${problems.join("; ")}`);
  }
  ensureDir(paths.captions);
  writeJson(captionsPath(), { schemaVersion: 1, scenes: cueSets });
  if (absoluteCues.length) {
    writeFileSync(
      `${paths.captions}/captions.srt`,
      toSrt(absoluteCues),
      "utf8",
    );
    log("Captions written: generated/captions/captions.json and captions.srt");
  }
  for (const derivation of derivations) log(`  ${derivation}`);

  const proof = subsetTimeline(
    timeline,
    [PROOF_SCENE],
    Math.round(PROOF_MAX_SECONDS * timeline.fps),
  );
  writeJson(`${paths.generated}/timeline.proof.json`, proof);

  log("");
  log(
    `Timeline: ${timeline.totalSeconds.toFixed(2)}s / ${timeline.totalFrames} frames at ${timeline.fps} fps`,
  );
  for (const scene of timeline.scenes)
    log(
      `  ${scene.id} ${scene.startSeconds.toFixed(2)}s + ${scene.durationSeconds.toFixed(2)}s (${scene.durationInFrames}f) narration ${scene.narrationSeconds?.toFixed(2) ?? "—"}s footage ${scene.footageSeconds?.toFixed(2) ?? "—"}s`,
    );
  log(
    `Proof excerpt: ${proof.totalSeconds.toFixed(2)}s from ${PROOF_SCENE}; run bun run video:proof`,
  );
  if (timeline.totalSeconds > manifest.maxSeconds)
    throw new Error("Timeline exceeds the delivery limit");
  log("Timeline manifest written to generated/timeline.json");
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:timeline failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
