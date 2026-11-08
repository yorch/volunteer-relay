import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ensureDir,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
  run,
  writeJson,
} from "../src/lib/cli.ts";
import { paths, videoRoot } from "../src/lib/env.ts";
import { measureLoudness, probeMedia } from "../src/lib/probe.ts";
import { finalRenderProblems } from "../src/lib/readiness.ts";
import { parseSceneManifest } from "../src/lib/schema.ts";
import {
  parseTimeline,
  subsetTimeline,
  type Timeline,
} from "../src/lib/timeline.ts";
import { ensureAccentAudio } from "./lib/accents.ts";
import { readCaptureManifest, readNarrationManifest } from "./lib/assets.ts";
import { mixNarration } from "./lib/audio-mix.ts";
import { resolveBrowserExecutable } from "./lib/browser.ts";
import { buildRenderProps, readCueSets } from "./lib/props-build.ts";
import { loadEverything } from "./lib/script.ts";

/**
 * Render a proof excerpt, a draft or the final programme through the Remotion
 * CLI. Nothing is published: renders land under the ignored output/ directory.
 */

const REMOTION_CLI = join(
  videoRoot,
  "node_modules/@remotion/cli/remotion-cli.js",
);

function renderComposition(input: {
  output: string;
  propsPath: string;
  draft: boolean;
}): void {
  if (!existsSync(REMOTION_CLI))
    throw new Error(
      "Remotion CLI is missing; run bun install in the repository root",
    );
  rmSync(input.output, { force: true });
  const args = [
    REMOTION_CLI,
    "render",
    "src/Root.tsx",
    "HackathonVideo",
    input.output,
    `--props=${input.propsPath}`,
    "--public-dir=generated",
    "--codec=h264",
    "--pixel-format=yuv420p",
    "--color-space=bt709",
    `--crf=${input.draft ? 28 : 18}`,
    "--concurrency=2",
    "--log=info",
  ];
  if (input.draft) args.push("--scale=0.5");
  const browser = resolveBrowserExecutable();
  if (browser) args.push(`--browser-executable=${browser}`);
  log(
    `Rendering ${input.draft ? "draft" : "full-resolution"} → ${input.output.replace(`${videoRoot}/`, "")}`,
  );
  const result = run(process.execPath, args, { cwd: videoRoot });
  if (result.status !== 0)
    throw new Error(
      `Remotion render failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const { manifest } = loadEverything();
  const parsedManifest = parseSceneManifest(
    JSON.parse(readFileSync(paths.scenes, "utf8")),
  );
  if (!existsSync(paths.timeline))
    throw new Error("No timeline manifest. Run bun run video:timeline first.");
  const fullTimeline = parseTimeline(
    JSON.parse(readFileSync(paths.timeline, "utf8")),
  );
  const proof = Boolean(args.flags.proof);
  const draft = Boolean(args.flags.draft);
  const sceneArg =
    typeof args.flags.scene === "string" ? args.flags.scene : null;

  let timeline: Timeline = fullTimeline;
  let mode: "full" | "proof" = "full";
  if (proof) {
    const proofPath = `${paths.generated}/timeline.proof.json`;
    if (!existsSync(proofPath))
      throw new Error("No proof timeline. Run bun run video:timeline first.");
    timeline = parseTimeline(JSON.parse(readFileSync(proofPath, "utf8")));
    mode = "proof";
  } else if (sceneArg) {
    const scene = parsedManifest.scenes.find((entry) => entry.id === sceneArg);
    if (!scene) throw new Error(`Unknown scene ${sceneArg}`);
    timeline = subsetTimeline(fullTimeline, [sceneArg]);
    mode = "proof";
  }

  const captures = readCaptureManifest();
  const narration = readNarrationManifest();
  const requestedOut =
    typeof args.flags.out === "string" ? args.flags.out : null;
  if (
    requestedOut?.endsWith("final.mp4") &&
    (mode !== "full" || proof || draft || sceneArg !== null)
  )
    throw new Error(
      "final.mp4 is reserved for a validated full render; render --proof/--draft or choose another --out",
    );
  if (mode === "full" && !draft && !proof) {
    const cueSets = readCueSets();
    const problems = finalRenderProblems({
      timeline,
      productScenes: parsedManifest.scenes
        .filter((scene) => scene.kind === "product")
        .map((scene) => scene.id),
      capturedSceneIds: (captures?.scenes ?? []).map((asset) => asset.sceneId),
      captureOrigins: (captures?.scenes ?? []).map((asset) => asset.baseUrl),
      currentNarration: (narration?.scenes ?? []).map((asset) => ({
        sceneId: asset.sceneId,
        durationSeconds: asset.durationSeconds,
        source: asset.source,
      })),
      captionedSceneIds: cueSets
        .filter((set) => set.cues.length > 0)
        .map((set) => set.sceneId),
      hasMusic: Boolean(process.env.VIDEO_MUSIC_FILE),
    });
    if (problems.length)
      throw new Error(
        `Refusing a final render:\n  - ${problems.join("\n  - ")}\nRenders are not published; fix the above or render --draft/--proof for iteration.`,
      );
  }
  const props = buildRenderProps({
    manifest: parsedManifest,
    timeline,
    captures,
    narration,
    mode,
  });
  ensureAccentAudio();
  const mix = narration ? mixNarration(narration) : null;
  if (mix) {
    props.narrationFiles = mix.files;
    props.assets.narration = true;
    log(
      `Narration mix: ${mix.gainRangeDb[0].toFixed(1)}…${mix.gainRangeDb[1].toFixed(1)} dB per scene${mix.limited ? " with limiter" : ""} (programme ${mix.programmeLufs?.toFixed(1) ?? "?"} LUFS)`,
    );
  }
  ensureDir(paths.generated);
  const propsPath = `${paths.generated}/render-props.json`;
  writeJson(propsPath, props);

  const output =
    typeof args.flags.out === "string"
      ? args.flags.out
      : proof
        ? join(paths.output, "proof.mp4")
        : sceneArg
          ? join(paths.output, `${sceneArg}.mp4`)
          : join(paths.output, draft ? "draft.mp4" : "final.mp4");
  ensureDir(paths.output);
  renderComposition({ output, propsPath, draft });

  const probe = probeMedia(output);
  const loudness = measureLoudness(output);
  const bytes = statSync(output).size;
  log(
    `Measured: ${probe.width}x${probe.height} ${probe.durationSeconds.toFixed(2)}s fps=${probe.fps?.toFixed(2) ?? "?"} video=${probe.videoCodec} audio=${probe.audioCodec} ${(bytes / 1_048_576).toFixed(1)} MiB`,
  );
  if (probe.hasAudio)
    log(
      `Audio: ${loudness.integratedLufs?.toFixed(1) ?? "?"} LUFS integrated, ${loudness.truePeakDb?.toFixed(1) ?? "?"} dBTP`,
    );
  else log("Audio: no audio stream (narration or music was absent)");
  const report = {
    schemaVersion: 1,
    mode,
    narrationSource: timeline.narrationSource,
    captureOrigin: captures?.targetMode ?? "none",
    manifestScenes: manifest.scenes.length,
    output: output.replace(`${videoRoot}/`, ""),
    bytes,
    measured: probe,
    loudness,
    renderedAt: new Date().toISOString(),
  };
  writeJson(`${paths.generated}/render-report.json`, report);
  if (probe.durationSeconds > parsedManifest.maxSeconds + 0.05)
    throw new Error(
      `Render runs ${probe.durationSeconds.toFixed(2)}s and exceeds the ${parsedManifest.maxSeconds}s limit`,
    );
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:render failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
