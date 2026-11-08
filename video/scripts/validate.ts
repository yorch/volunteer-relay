import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateCues } from "../src/lib/captions.ts";
import {
  ensureDir,
  gitIgnored,
  log,
  Report,
  requireNode26,
  type Step,
  writeJson,
} from "../src/lib/cli.ts";
import { assertNoSecrets, paths, repoRoot, videoRoot } from "../src/lib/env.ts";
import { measureLoudness, probeMedia } from "../src/lib/probe.ts";
import { finalRenderProblems } from "../src/lib/readiness.ts";
import { loadExpectedResults, loadScenario } from "../src/lib/scenario.ts";
import { parseSceneManifest, productScenes } from "../src/lib/schema.ts";
import { parseTimeline } from "../src/lib/timeline.ts";
import {
  captureMezzaninePath,
  narrationFile,
  readCaptureManifest,
  readNarrationManifest,
} from "./lib/assets.ts";
import {
  captionsPath,
  cuesForTimeline,
  readCueSets,
} from "./lib/props-build.ts";

/**
 * Validate manifests, media properties, caption timing, missing files, total
 * duration and the rendered output audio. This is the gate a render must pass
 * before it counts as ready.
 */

const report = new Report();
const step = (name: string, status: Step["status"], detail: string) =>
  report.add({ name, status, detail });

function main(): void {
  requireNode26();
  const manifest = parseSceneManifest(
    JSON.parse(readFileSync(paths.scenes, "utf8")),
  );
  const scenario = loadScenario(paths.scenario);
  const expected = loadExpectedResults(paths.expectedResults);
  step(
    "scene manifest",
    "ok",
    `${manifest.scenes.length} scenes, ${manifest.fps} fps, max ${manifest.maxSeconds}s`,
  );
  step(
    "recording scenario",
    existsSync(join(repoRoot, scenario.oracleFile)) ? "ok" : "blocked",
    `${scenario.scenarioId}; oracle ${scenario.oracleFile}`,
  );
  step(
    "authored baselines",
    Object.keys(expected.checkpoints).length > 0 ? "ok" : "blocked",
    `${Object.keys(expected.checkpoints).length} checkpoint(s) authored`,
  );
  try {
    assertNoSecrets(manifest, "scenes.json");
    assertNoSecrets(scenario, "recording-scenario.json");
    step("no secrets in manifests", "ok", "no credential values found");
  } catch (error) {
    step("no secrets in manifests", "blocked", (error as Error).message);
  }

  for (const path of [
    "video/.env.local",
    "video/.auth/x.json",
    "video/generated/x.json",
    "video/output/x.mp4",
  ])
    step(
      `ignore rule ${path}`,
      gitIgnored(repoRoot, path) ? "ok" : "blocked",
      gitIgnored(repoRoot, path) ? "ignored" : "must be ignored",
    );

  const narration = readNarrationManifest();
  if (!narration) {
    step(
      "narration",
      "blocked",
      "generated/narration/manifest.json is missing",
    );
  } else {
    const missing = manifest.scenes.filter(
      (scene) => !narration.scenes.some((asset) => asset.sceneId === scene.id),
    );
    step(
      "narration coverage",
      missing.length === 0 ? "ok" : "blocked",
      missing.length === 0
        ? `${manifest.scenes.length} scenes, source ${narration.provider}`
        : `missing ${missing.map((scene) => scene.id).join(", ")}`,
    );
    for (const asset of narration.scenes) {
      if (!existsSync(narrationFile(asset.sceneId))) {
        step(`${asset.sceneId} narration`, "blocked", "audio file is missing");
        continue;
      }
      const probe = probeMedia(narrationFile(asset.sceneId));
      step(
        `${asset.sceneId} narration`,
        probe.hasAudio &&
          Math.abs(probe.durationSeconds - asset.durationSeconds) < 0.1
          ? "ok"
          : "warn",
        `${probe.durationSeconds.toFixed(2)}s measured, ${asset.durationSeconds.toFixed(2)}s recorded, audio=${probe.audioCodec ?? "none"}`,
      );
    }
    if (narration.provider === "scratch-local-voice")
      step(
        "narration provenance",
        "warn",
        "scratch local voice was used for timing only; it is not final narration",
      );
  }

  const captures = readCaptureManifest();
  if (!captures) {
    step("captures", "blocked", "generated/capture-manifest.json is missing");
  } else {
    const needed = productScenes(manifest);
    const missing = needed.filter(
      (scene) => !captures.scenes.some((asset) => asset.sceneId === scene.id),
    );
    step(
      "capture coverage",
      missing.length === 0 ? "ok" : "blocked",
      missing.length === 0
        ? `${needed.length} product scenes from ${captures.targetMode} (${captures.baseUrl})`
        : `missing ${missing.map((scene) => scene.id).join(", ")}`,
    );
    const origins = new Set(
      captures.scenes.map((asset) => `${asset.origin} ${asset.baseUrl}`),
    );
    step(
      "capture origin consistency",
      origins.size <= 1 ? "ok" : "blocked",
      origins.size <= 1
        ? `single origin: ${[...origins].join(", ") || "none"}`
        : `mixed origins ${[...origins].join(", ")}; never present local and hosted footage as one release`,
    );
    for (const asset of captures.scenes) {
      const path = captureMezzaninePath(asset.sceneId);
      if (!existsSync(path)) {
        step(
          `${asset.sceneId} capture`,
          "blocked",
          "mezzanine file is missing",
        );
        continue;
      }
      const probe = probeMedia(path);
      step(
        `${asset.sceneId} capture`,
        probe.width === 1920 &&
          probe.height === 1080 &&
          probe.durationSeconds > 0
          ? "ok"
          : "blocked",
        `${probe.width}x${probe.height} ${probe.durationSeconds.toFixed(2)}s fps=${probe.fps?.toFixed(2) ?? "?"}`,
      );
    }
  }

  if (!existsSync(paths.timeline)) {
    step("timeline", "blocked", "generated/timeline.json is missing");
  } else {
    const timeline = parseTimeline(
      JSON.parse(readFileSync(paths.timeline, "utf8")),
    );
    let contiguous = timeline.scenes[0]?.startFrame === 0;
    for (const [index, scene] of timeline.scenes.entries()) {
      const previous = timeline.scenes[index - 1];
      if (
        previous &&
        previous.startFrame + previous.durationInFrames !== scene.startFrame
      )
        contiguous = false;
    }
    const endsAtTotal =
      timeline.scenes.reduce(
        (sum, scene) => sum + scene.durationInFrames,
        0,
      ) === timeline.totalFrames;
    step(
      "timeline",
      contiguous && endsAtTotal && timeline.totalSeconds <= manifest.maxSeconds
        ? "ok"
        : "blocked",
      `${timeline.totalSeconds.toFixed(2)}s, ${timeline.totalFrames} frames, contiguous=${contiguous}, endsAtTotal=${endsAtTotal}`,
    );
    if (captures)
      for (const scene of timeline.scenes) {
        const asset = captures.scenes.find(
          (entry) => entry.sceneId === scene.id,
        );
        if (asset && asset.durationSeconds + 1e-3 < scene.durationSeconds)
          step(
            `${scene.id} footage length`,
            "blocked",
            `footage ${asset.durationSeconds.toFixed(2)}s is shorter than the ${scene.durationSeconds.toFixed(2)}s scene`,
          );
      }
  }

  if (!existsSync(captionsPath())) {
    step("captions", "blocked", "generated/captions/captions.json is missing");
  } else if (!existsSync(paths.timeline)) {
    step("captions", "blocked", "captions need the timeline to place cues");
  } else {
    const timeline = parseTimeline(
      JSON.parse(readFileSync(paths.timeline, "utf8")),
    );
    const cueSets = readCueSets();
    const cues = cuesForTimeline(timeline, cueSets);
    const srt = `${paths.captions}/captions.srt`;
    if (!existsSync(srt))
      step("captions srt", "blocked", "captions.srt is missing");
    else {
      const entries = readFileSync(srt, "utf8")
        .split(/\n\n/)
        .filter(Boolean).length;
      step(
        "captions srt",
        entries === cues.length ? "ok" : "blocked",
        `${entries} cue(s) in SRT, ${cues.length} placed on the timeline`,
      );
    }
    const problems = validateCues(cues, timeline.totalSeconds);
    step(
      "caption timing",
      problems.length === 0 && cues.length > 0 ? "ok" : "blocked",
      cues.length === 0
        ? "no cues derived; narration is missing"
        : problems.length === 0
          ? `${cues.length} cues inside ${timeline.totalSeconds.toFixed(2)}s, max two lines`
          : problems.join("; "),
    );
    const derived = new Set(cueSets.map((set) => set.derived));
    if (derived.has("proportional-phrase"))
      step(
        "caption provenance",
        "warn",
        "some cues use proportional phrase timing, not provider alignment",
      );
  }

  // A final render must also satisfy the readiness gate the renderer enforces.
  if (
    existsSync(join(paths.output, "final.mp4")) &&
    existsSync(paths.timeline)
  ) {
    const timeline = parseTimeline(
      JSON.parse(readFileSync(paths.timeline, "utf8")),
    );
    const cueSets = existsSync(captionsPath()) ? readCueSets() : [];
    const problems = finalRenderProblems({
      timeline,
      productScenes: productScenes(manifest).map((scene) => scene.id),
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
    step(
      "final readiness",
      problems.length === 0 ? "ok" : "blocked",
      problems.length === 0
        ? "narration, captures, captions and origin all ready"
        : problems.join("; "),
    );
  }

  const renderReportPath = `${paths.generated}/render-report.json`;
  const renderReport = existsSync(renderReportPath)
    ? (JSON.parse(readFileSync(renderReportPath, "utf8")) as {
        mode?: string;
        output?: string;
      })
    : null;
  if (existsSync(join(paths.output, "final.mp4"))) {
    step(
      "final render identity",
      renderReport?.mode === "full" &&
        renderReport.output?.endsWith("final.mp4")
        ? "ok"
        : "blocked",
      renderReport?.mode === "full"
        ? "final.mp4 came from a full render"
        : `final.mp4 is not backed by a full-render report (saw mode ${renderReport?.mode ?? "none"})`,
    );
    if (existsSync(paths.timeline)) {
      const timeline = parseTimeline(
        JSON.parse(readFileSync(paths.timeline, "utf8")),
      );
      const measured = probeMedia(
        join(paths.output, "final.mp4"),
      ).durationSeconds;
      step(
        "final render duration",
        Math.abs(measured - timeline.totalSeconds) <= 0.1 ? "ok" : "blocked",
        `${measured.toFixed(2)}s measured, ${timeline.totalSeconds.toFixed(2)}s planned full programme`,
      );
    }
  }

  const output = join(paths.output, "proof.mp4");
  const final = join(paths.output, "final.mp4");
  for (const [label, path] of [
    ["proof render", output],
    ["final render", final],
  ] as const) {
    if (!existsSync(path)) {
      step(label, "skipped", "not rendered yet");
      continue;
    }
    const probe = probeMedia(path);
    const loudness = measureLoudness(path);
    const problems: string[] = [];
    if (probe.width !== 1920 || probe.height !== 1080)
      problems.push(`dimensions ${probe.width}x${probe.height}`);
    if (probe.videoCodec !== "h264")
      problems.push(`video codec ${probe.videoCodec}`);
    if (probe.hasAudio && probe.audioCodec !== "aac")
      problems.push(`audio codec ${probe.audioCodec}`);
    if (probe.fps !== null && Math.abs(probe.fps - 30) > 0.01)
      problems.push(`fps ${probe.fps.toFixed(2)}`);
    if (probe.durationSeconds > manifest.maxSeconds + 0.05)
      problems.push(`duration ${probe.durationSeconds.toFixed(2)}s`);
    step(
      label,
      problems.length === 0 ? "ok" : "blocked",
      problems.length === 0
        ? `${probe.durationSeconds.toFixed(2)}s ${(statSync(path).size / 1_048_576).toFixed(1)} MiB, audio=${probe.audioCodec ?? "none"}`
        : problems.join("; "),
    );
    if (!probe.hasAudio)
      step(`${label} audio`, "warn", "no audio stream; narration was absent");
    else
      step(
        `${label} loudness`,
        loudness.integratedLufs !== null &&
          loudness.integratedLufs >= -17 &&
          loudness.integratedLufs <= -15 &&
          (loudness.truePeakDb ?? 0) <= -1
          ? "ok"
          : "warn",
        `${loudness.integratedLufs?.toFixed(1) ?? "?"} LUFS integrated, ${loudness.truePeakDb?.toFixed(1) ?? "?"} dBTP (targets -16 LUFS, ≤ -1 dBTP)`,
      );
  }

  step(
    "licence and attribution",
    existsSync(join(videoRoot, "docs", "asset-licenses.md")) ? "ok" : "blocked",
    "docs/asset-licenses.md must record Remotion eligibility and media licences",
  );

  ensureDir(paths.generated);
  writeJson(`${paths.generated}/validation-report.json`, {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    summary: report.summary(),
    steps: report.blocked(),
  });
  log("");
  log(`summary: ${report.summary()}`);
  if (report.blocked().length) {
    log(
      `blockers: ${report
        .blocked()
        .map((entry) => entry.name)
        .join(", ")}`,
    );
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`video:validate failed: ${(error as Error).message}\n`);
  process.exitCode = 2;
}
