import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  commandExists,
  gitCommit,
  gitIgnored,
  log,
  Report,
  requireNode26,
  run,
  type Step,
} from "../src/lib/cli.ts";
import {
  describeEnv,
  loadEnv,
  paths,
  repoRoot,
  videoRoot,
} from "../src/lib/env.ts";
import { loadExpectedResults, loadScenario } from "../src/lib/scenario.ts";
import { productScenes } from "../src/lib/schema.ts";
import { loadSceneManifest } from "../src/lib/schema-io.ts";
import { resolveTarget } from "../src/lib/target.ts";
import { captureManifestPath, timelinePath } from "./lib/assets.ts";
import { resolveBrowserExecutable } from "./lib/browser.ts";

/**
 * Read-only readiness check. Never starts containers, downloads packages or
 * spends provider credits. Secrets are reported as configured/missing only.
 */

const report = new Report();

function step(name: string, status: Step["status"], detail: string): void {
  report.add({ name, status, detail });
}

async function main(): Promise<void> {
  requireNode26();
  const env = loadEnv();

  step(
    "node runtime",
    process.versions.node === "26.11.1" ? "ok" : "blocked",
    process.versions.node,
  );
  step(
    "bun package manager",
    commandExists("bun") ? "ok" : "blocked",
    commandExists("bun") ? run("bun", ["--version"]).stdout.trim() : "missing",
  );
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const exists = commandExists(tool);
    step(
      `${tool}`,
      exists ? "ok" : "blocked",
      exists
        ? (run(tool, ["-version"]).stdout.split("\n")[0]?.trim() ?? "present")
        : "install ffmpeg (includes ffprobe) for probing, mixing and validation",
    );
  }

  try {
    const manifest = loadSceneManifest(paths.scenes);
    const product = productScenes(manifest);
    step(
      "scene manifest",
      "ok",
      `${manifest.scenes.length} scenes (${product.length} product, ${manifest.scenes.length - product.length} graphic), ${manifest.fps} fps, max ${manifest.maxSeconds}s`,
    );
  } catch (error) {
    step("scene manifest", "blocked", (error as Error).message);
  }

  try {
    const scenario = loadScenario(paths.scenario);
    const expected = loadExpectedResults(paths.expectedResults);
    step(
      "recording scenario",
      "ok",
      `${scenario.scenarioId}; ${scenario.identities.length} identities; ${scenario.checkpoints.length} checkpoints; oracle ${expected.authorship.slice(0, 40)}…`,
    );
    const oracle = join(repoRoot, scenario.oracleFile);
    step(
      "product oracle",
      existsSync(oracle) ? "ok" : "blocked",
      oracle.replace(`${repoRoot}/`, ""),
    );
  } catch (error) {
    step("recording scenario", "blocked", (error as Error).message);
  }

  const envState = describeEnv(env);
  step(
    "environment variables",
    envState.missing.length === 0 ? "ok" : "warn",
    envState.missing.length === 0
      ? "all documented variables are set"
      : `${envState.missing.length} unset: ${envState.missing.join(", ")}`,
  );
  const hostedCredentials = [
    "VIDEO_OWEN_PASSWORD",
    "VIDEO_MARISOL_PASSWORD",
    "VIDEO_SOFIA_PASSWORD",
  ].every((name) => Boolean(env[name]));
  step(
    "capture credentials",
    hostedCredentials ? "ok" : "blocked",
    hostedCredentials
      ? "coordinator, owner and volunteer credentials are configured"
      : "missing recording-account passwords; run video:provision or supply video/.env.local",
  );
  step(
    "narration credentials",
    env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID ? "ok" : "warn",
    env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID
      ? "ElevenLabs key and voice are configured"
      : "no ElevenLabs configuration; narration is blocked unless supplied audio is used",
  );
  step(
    "optional music bed",
    env.VIDEO_MUSIC_FILE ? "ok" : "skipped",
    env.VIDEO_MUSIC_FILE
      ? "music file configured; licence must be recorded in docs/asset-licenses.md"
      : "narration only (default)",
  );

  try {
    const target = resolveTarget(env);
    step(
      "capture target",
      "ok",
      `${target.baseUrl} (${target.mode}); credentials only go to ${target.allowedOrigin}`,
    );
    const health = await fetch(`${target.baseUrl}/api/health`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    step(
      "target reachability",
      health?.ok ? "ok" : "warn",
      health?.ok
        ? `HTTP ${health.status} from /api/health`
        : "no healthy response from /api/health (check network, TLS and deployment)",
    );
  } catch (error) {
    step("capture target", "blocked", (error as Error).message);
  }

  for (const [label, path] of [
    ["video/.env.local ignore rule", "video/.env.local"],
    ["video/.auth ignore rule", "video/.auth/state.json"],
    ["video/generated ignore rule", "video/generated/x.json"],
    ["video/output ignore rule", "video/output/x.mp4"],
  ] as const) {
    step(
      label,
      gitIgnored(repoRoot, path) ? "ok" : "blocked",
      gitIgnored(repoRoot, path) ? "ignored" : "not ignored by git",
    );
  }

  const remotion = join(videoRoot, "node_modules", "remotion");
  step(
    "remotion packages",
    existsSync(remotion) ? "ok" : "blocked",
    existsSync(remotion)
      ? "installed in video/node_modules"
      : "run bun install",
  );
  const browser = resolveBrowserExecutable();
  step(
    "remotion browser",
    browser ? "ok" : "warn",
    browser
      ? `using ${browser.replace(`${process.env.HOME ?? ""}/`, "~/")}`
      : "no local browser found; the first render downloads one",
  );

  const narration = existsSync(paths.narration)
    ? statSync(paths.narration).isDirectory()
    : false;
  step(
    "narration assets",
    narration ? "ok" : "warn",
    narration
      ? "generated/narration exists"
      : "none yet; run video:voice (blocked without credentials) or --audio-dir",
  );
  step(
    "capture assets",
    existsSync(paths.captures) ? "ok" : "warn",
    existsSync(paths.captures)
      ? "generated/captures exists"
      : "none yet; run video:auth then video:capture",
  );
  step(
    "timeline manifest",
    existsSync(timelinePath()) ? "ok" : "warn",
    existsSync(timelinePath())
      ? "generated/timeline.json present"
      : "run video:timeline after narration and captures",
  );
  step(
    "capture manifest",
    existsSync(captureManifestPath()) ? "ok" : "warn",
    existsSync(captureManifestPath()) ? "present" : "run video:capture",
  );
  step(
    "remotion licence note",
    existsSync(join(videoRoot, "docs", "asset-licenses.md")) ? "ok" : "blocked",
    "docs/asset-licenses.md records source-available licence eligibility",
  );

  log("");
  log(`commit: ${gitCommit(repoRoot) ?? "unknown"}`);
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

await main().catch((error: unknown) => {
  process.stderr.write(`doctor failed: ${(error as Error).message}\n`);
  process.exitCode = 2;
});
