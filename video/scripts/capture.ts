import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  ensureDir,
  gitCommit,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
  run,
} from "../src/lib/cli.ts";
import { paths, repoRoot } from "../src/lib/env.ts";
import { probeMedia } from "../src/lib/probe.ts";
import { loadExpectedResults, loadScenario } from "../src/lib/scenario.ts";
import { productScenes, type Scene } from "../src/lib/schema.ts";
import { resolveTarget } from "../src/lib/target.ts";
import { assertTotals, sceneActions } from "./lib/actions.ts";
import {
  type CaptureAsset,
  captureMezzaninePath,
  captureRawPath,
  readCaptureManifest,
  readNarrationManifest,
  writeCaptureManifest,
} from "./lib/assets.ts";
import { loadEverything } from "./lib/script.ts";
import {
  newRecordingContext,
  openPage,
  storageStatePath,
} from "./lib/session.ts";

/**
 * Deterministic 1920x1080 capture of genuine application state. Each take starts
 * from a declared checkpoint, proves persisted totals before and after, and
 * fails closed instead of rendering a plausible but wrong scene.
 */

const HOLD_BUFFER_SECONDS = 1.5;

function normalizeCapture(sceneId: string): ReturnType<typeof probeMedia> {
  const raw = captureRawPath(sceneId);
  const mezzanine = captureMezzaninePath(sceneId);
  const staged = `${mezzanine}.staged.mp4`;
  rmSync(staged, { force: true });
  const result = run("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    raw,
    "-vf",
    "scale=1920:1080:flags=lanczos,fps=30,setsar=1",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-an",
    staged,
  ]);
  if (result.status !== 0) {
    rmSync(staged, { force: true });
    throw new Error(`Normalising ${sceneId} failed: ${result.stderr.trim()}`);
  }
  // Prove the staged mezzanine before it replaces an accepted capture.
  const probe = probeMedia(staged);
  if (probe.width !== 1920 || probe.height !== 1080) {
    rmSync(staged, { force: true });
    throw new Error(
      `${sceneId} normalised to ${probe.width}x${probe.height}, expected 1920x1080`,
    );
  }
  renameSync(staged, mezzanine);
  rmSync(raw, { force: true });
  return probe;
}

async function captureScene(
  scene: Scene,
  env: Record<string, string | undefined>,
): Promise<CaptureAsset> {
  const target = resolveTarget(env);
  const narration = readNarrationManifest();
  const scenario = loadScenario(paths.scenario);
  const expected = loadExpectedResults(paths.expectedResults);
  const action = sceneActions[scene.id];
  if (!action)
    throw new Error(`No capture action is registered for ${scene.id}`);
  if (!scene.capture) throw new Error(`${scene.id} has no capture plan`);
  const statePath = storageStatePath(scene.capture.role);
  if (!existsSync(statePath))
    throw new Error(
      `Missing ${scene.capture.role} session. Run bun run video:auth first.`,
    );

  const browser = await chromium.launch();
  ensureDir(paths.captures);
  const before = new Set(readdirSync(paths.captures));
  const cleanupLeftovers = () => {
    for (const entry of readdirSync(paths.captures))
      if (!before.has(entry))
        rmSync(join(paths.captures, entry), { force: true });
  };
  const recordedAt = new Date().toISOString();
  const markers: Array<{ label: string; atSeconds: number }> = [];
  const started = performance.now();
  const mark = (label: string) => {
    markers.push({
      label,
      atSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    });
    log(`    · ${label}`);
  };
  let produced: string | null = null;
  let probe: ReturnType<typeof probeMedia>;
  try {
    const context = await newRecordingContext(
      browser,
      target,
      scene.capture.role,
    );
    const page = await openPage(context, target, scene.capture.route);
    await page.evaluate(() => window.scrollTo(0, 0));
    const ready = page.getByText(scene.capture.readyText, { exact: false });
    await ready.first().waitFor({ timeout: 30_000 });

    const actionContext = {
      page,
      target,
      scenario,
      expected,
      mark,
    };
    await assertTotals(actionContext, action.startsFrom);
    mark(`checkpoint:${action.startsFrom}`);
    await action.run(actionContext);
    if (action.establishes) {
      await assertTotals(actionContext, action.establishes);
      mark(`checkpoint:${action.establishes}`);
    }

    // Hold long enough for the scene's *measured* narration, not just its
    // editorial floor: the timeline refuses footage shorter than its scene.
    const narrationSeconds =
      narration?.scenes.find((asset) => asset.sceneId === scene.id)
        ?.durationSeconds ?? null;
    const plannedSeconds = Math.max(
      scene.minSeconds,
      narrationSeconds === null ? 0 : narrationSeconds + 0.6,
    );
    const elapsed = (performance.now() - started) / 1000;
    const hold = Math.max(0, plannedSeconds + HOLD_BUFFER_SECONDS - elapsed);
    if (hold > 0) await page.waitForTimeout(hold * 1000);
    mark("hold-complete");

    const video = page.video();
    await context.close();
    produced = video ? await video.path() : null;
    if (!produced || !existsSync(produced))
      throw new Error(`Playwright produced no video for ${scene.id}`);
  } finally {
    // Close before any cleanup: a recording still being finalised must not race
    // the directory sweep below.
    await browser.close();
  }

  try {
    ensureDir(paths.captures);
    const raw = captureRawPath(scene.id);
    rmSync(raw, { force: true });
    renameSync(produced, raw);
    probe = normalizeCapture(scene.id);
  } catch (error) {
    cleanupLeftovers();
    throw error;
  }

  if (probe.width === null || probe.height === null)
    throw new Error(`${scene.id} has no video dimensions`);
  return {
    sceneId: scene.id,
    file: `captures/${scene.id}.mp4`,
    durationSeconds: probe.durationSeconds,
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
    origin: target.originLabel,
    baseUrl: target.baseUrl,
    appCommit: gitCommit(repoRoot),
    scenarioId: scenario.scenarioId,
    checkpointId: action.startsFrom,
    role: scene.capture.role,
    recordedAt,
    markers,
  };
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const { env, manifest } = loadEverything();
  const target = resolveTarget(env);
  const only = typeof args.flags.scene === "string" ? args.flags.scene : null;
  const scenes = productScenes(manifest).filter(
    (scene) => !only || scene.id === only,
  );
  if (scenes.length === 0)
    throw new Error(
      only ? `Unknown product scene ${only}` : "No product scenes",
    );

  log(
    `Capturing ${scenes.length} scene(s) at 1920x1080 from ${target.baseUrl} (${target.originLabel})`,
  );
  let existing = null;
  try {
    existing = readCaptureManifest();
  } catch (error) {
    if (!args.flags.fresh)
      throw new Error(
        `${(error as Error).message}\nPass --fresh to discard generated captures and start a clean capture set, or restore a compatible manifest.`,
      );
    log("Discarding an incompatible capture manifest and its media (--fresh).");
  }
  if (args.flags.fresh) {
    rmSync(paths.captureManifest, { force: true });
    const media = join(paths.captures);
    if (existsSync(media))
      for (const entry of readdirSync(media))
        rmSync(join(media, entry), { force: true });
    existing = null;
  }
  if (
    existing &&
    (existing.targetMode !== target.mode || existing.baseUrl !== target.baseUrl)
  )
    throw new Error(
      `Existing captures came from ${existing.baseUrl} (${existing.targetMode}). Remove generated/captures and generated/capture-manifest.json before capturing from ${target.baseUrl}; one delivery never mixes origins.`,
    );
  const byId = new Map(
    (existing?.scenes ?? []).map((asset) => [asset.sceneId, asset]),
  );
  const publish = (asset: CaptureAsset) => {
    byId.set(asset.sceneId, asset);
    writeCaptureManifest({
      schemaVersion: 1,
      scenarioId: loadScenario(paths.scenario).scenarioId,
      targetMode: target.mode,
      baseUrl: target.baseUrl,
      appCommit: gitCommit(repoRoot),
      capturedAt: new Date().toISOString(),
      scenes: [...byId.values()].sort((a, b) =>
        a.sceneId < b.sceneId ? -1 : 1,
      ),
    });
  };
  for (const scene of scenes) {
    log(`  ${scene.id} ${scene.title}`);
    const asset = await captureScene(scene, env);
    publish(asset);
    log(
      `  ${scene.id}: ${asset.durationSeconds.toFixed(2)}s, ${asset.width}x${asset.height}, ${asset.markers.length} markers`,
    );
  }
  log(
    "Capture manifest written. A subset capture only matches a database still at that scene's start checkpoint.",
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:capture failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
