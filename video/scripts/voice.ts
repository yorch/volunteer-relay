import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ensureDir,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
  run,
  writeJson,
  writePrivate,
} from "../src/lib/cli.ts";
import {
  estimateBillableCharacters,
  narrationCacheKey,
  narrationVoiceSettings,
  requestNarration,
} from "../src/lib/elevenlabs.ts";
import { paths } from "../src/lib/env.ts";
import { probeMedia } from "../src/lib/probe.ts";
import { type Scene, sceneById } from "../src/lib/schema.ts";
import {
  alignmentFile,
  type NarrationAsset,
  narrationFile,
  readNarrationManifest,
  writeNarrationManifest,
} from "./lib/assets.ts";
import {
  loadEverything,
  requireNarrationEnv,
  scriptStats,
} from "./lib/script.ts";

/**
 * Narration generation. Paid calls happen only with `--yes`, one scene at a
 * time, capped at two attempts. Existing results are reused by cache key, so a
 * rerun never pays twice for unchanged text, voice or settings.
 */

const MAX_ATTEMPTS = 2;

function pronunciations(): Record<string, string> {
  const path = join(paths.videoRoot, "narration", "pronunciations.json");
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    entries?: Array<{ written?: string; spoken?: string }>;
  };
  const map: Record<string, string> = {};
  for (const entry of parsed.entries ?? [])
    if (entry.written && entry.spoken) map[entry.written] = entry.spoken;
  return map;
}

/** Applies pronunciation overrides to the text actually sent to the provider. */
export function applyPronunciations(
  text: string,
  overrides: Record<string, string>,
): string {
  let output = text;
  for (const [written, spoken] of Object.entries(overrides))
    output = output.split(written).join(spoken);
  return output;
}

interface CacheState {
  hits: Scene[];
  missing: Scene[];
}

function inspectCache(
  scenes: readonly Scene[],
  keyFor: (scene: Scene) => string,
  known: Map<string, string | null>,
): CacheState {
  const hits: Scene[] = [];
  const missing: Scene[] = [];
  for (const scene of scenes) {
    const key = keyFor(scene);
    const recorded = known.get(scene.id);
    if (recorded === key && existsSync(narrationFile(scene.id)))
      hits.push(scene);
    else missing.push(scene);
  }
  return { hits, missing };
}

async function generateWithElevenLabs(
  scenes: readonly Scene[],
  env: Record<string, string | undefined>,
  overrides: Record<string, string>,
  source: "elevenlabs",
): Promise<void> {
  const { apiKey, voiceId, modelId } = requireNarrationEnv(env);
  const existing = readNarrationManifest();
  const assets = new Map<string, NarrationAsset>(
    (existing?.scenes ?? []).map((asset) => [asset.sceneId, asset]),
  );
  ensureDir(paths.narration);
  ensureDir(paths.alignments);
  for (const scene of scenes) {
    const text = applyPronunciations(scene.narration, overrides);
    const key = narrationCacheKey({
      text,
      provider: "elevenlabs",
      modelId,
      voiceId,
      settings: narrationVoiceSettings,
      pronunciations: overrides,
      outputFormat: "mp3_44100_128",
    });
    let attempt = 0;
    let lastError: Error | null = null;
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      try {
        log(
          `  ${scene.id}: requesting narration (attempt ${attempt}/${MAX_ATTEMPTS})`,
        );
        const result = await requestNarration({
          apiKey,
          voiceId,
          modelId,
          text,
          settings: narrationVoiceSettings,
          pronunciations: overrides,
        });
        writePrivate(
          narrationFile(scene.id),
          Buffer.from(result.audio).toString("binary"),
        );
        writeJson(alignmentFile(scene.id), result.alignment);
        const probe = probeMedia(narrationFile(scene.id));
        assets.set(scene.id, {
          sceneId: scene.id,
          file: `narration/${scene.id}.mp3`,
          durationSeconds: probe.durationSeconds,
          source,
          cacheKey: key,
          generatedAt: new Date().toISOString(),
        });
        log(
          `  ${scene.id}: ${probe.durationSeconds.toFixed(2)}s of audio (${text.length} characters)`,
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error as Error;
        log(`  ${scene.id}: attempt failed: ${lastError.message}`);
      }
    }
    if (lastError)
      throw new Error(
        `${scene.id}: narration failed after ${MAX_ATTEMPTS} attempts`,
      );
  }
  writeNarrationManifest({
    schemaVersion: 1,
    provider: "elevenlabs",
    voiceId,
    modelId,
    generatedAt: new Date().toISOString(),
    scenes: [...assets.values()].sort((a, b) =>
      a.sceneId < b.sceneId ? -1 : 1,
    ),
  });
}

function importSuppliedAudio(
  scenes: readonly Scene[],
  directory: string,
): void {
  ensureDir(paths.narration);
  const assets: NarrationAsset[] = [];
  for (const scene of scenes) {
    const source = join(directory, `${scene.id}.mp3`);
    if (!existsSync(source))
      throw new Error(
        `Supplied audio is missing ${scene.id}.mp3 in ${directory}; every scene needs a file`,
      );
    copyFileSync(source, narrationFile(scene.id));
    const probe = probeMedia(narrationFile(scene.id));
    assets.push({
      sceneId: scene.id,
      file: `narration/${scene.id}.mp3`,
      durationSeconds: probe.durationSeconds,
      source: "supplied-audio",
      cacheKey: null,
      generatedAt: new Date().toISOString(),
    });
    log(`  ${scene.id}: imported ${probe.durationSeconds.toFixed(2)}s`);
  }
  writeNarrationManifest({
    schemaVersion: 1,
    provider: "supplied-audio",
    voiceId: null,
    modelId: null,
    generatedAt: new Date().toISOString(),
    scenes: assets,
  });
}

/**
 * Local scratch voice for timing only. Clearly labelled in the manifest; it is
 * never presented as final narration.
 */
function generateScratch(scenes: readonly Scene[]): void {
  ensureDir(paths.narration);
  const assets: NarrationAsset[] = [];
  for (const scene of scenes) {
    const aiff = join(paths.narration, `${scene.id}.aiff`);
    log(`  ${scene.id}: generating local scratch voice (not final narration)`);
    const say = run("say", ["-o", aiff, scene.narration]);
    if (say.status !== 0)
      throw new Error(
        `Local scratch voice is unavailable: ${say.stderr.trim() || "say failed"}`,
      );
    const convert = run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      aiff,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      narrationFile(scene.id),
    ]);
    if (convert.status !== 0)
      throw new Error(
        `Scratch audio conversion failed: ${convert.stderr.trim()}`,
      );
    const probe = probeMedia(narrationFile(scene.id));
    assets.push({
      sceneId: scene.id,
      file: `narration/${scene.id}.mp3`,
      durationSeconds: probe.durationSeconds,
      source: "scratch-local-voice",
      cacheKey: null,
      generatedAt: new Date().toISOString(),
    });
  }
  writeNarrationManifest({
    schemaVersion: 1,
    provider: "scratch-local-voice",
    voiceId: null,
    modelId: null,
    generatedAt: new Date().toISOString(),
    scenes: assets,
  });
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const { env, manifest } = loadEverything();
  const overrides = pronunciations();
  const stats = scriptStats(manifest.scenes);
  const estimate = estimateBillableCharacters(manifest.scenes);
  const selected =
    typeof args.flags.scene === "string"
      ? [sceneById(manifest, args.flags.scene)]
      : manifest.scenes;

  log(`Narration draft: ${stats.words} words, ${stats.characters} characters`);
  for (const scene of estimate.perScene)
    log(`  ${scene.id}: ${scene.characters} characters`);
  if (stats.words < 350 || stats.words > 390)
    log(
      `note: the brief targets 350–390 words; the current draft has ${stats.words}. Adjust deliberately, not by speeding the voice.`,
    );

  const eleven = requireNarrationEnvSafe(env);
  const keyFor = (scene: Scene) =>
    narrationCacheKey({
      text: applyPronunciations(scene.narration, overrides),
      provider: "elevenlabs",
      modelId: eleven.modelId,
      voiceId: eleven.voiceId,
      settings: narrationVoiceSettings,
      pronunciations: overrides,
      outputFormat: "mp3_44100_128",
    });
  const existing = readNarrationManifest();
  const known = new Map<string, string | null>(
    (existing?.scenes ?? []).map((asset) => [asset.sceneId, asset.cacheKey]),
  );
  const cache = inspectCache(selected, keyFor, known);
  const audioDir =
    typeof args.flags["audio-dir"] === "string"
      ? args.flags["audio-dir"]
      : null;

  if (args.flags["dry-run"]) {
    log(
      `Provider: ${audioDir ? "supplied-audio" : eleven.configured ? "elevenlabs" : "unconfigured"}`,
    );
    log(
      `Cache hits: ${cache.hits.map((scene) => scene.id).join(", ") || "none"}`,
    );
    log(
      `Would generate: ${cache.missing.map((scene) => scene.id).join(", ") || "none"}`,
    );
    log(
      `Estimated billable text if generated: ${cache.missing.reduce((sum, scene) => sum + scene.narration.length, 0)} characters`,
    );
    return;
  }

  if (args.flags.scratch) {
    generateScratch(selected);
    log("Scratch narration written and labelled as scratch-local-voice.");
    return;
  }
  if (audioDir) {
    importSuppliedAudio(selected, audioDir);
    log(`Imported supplied audio from ${basename(audioDir)}.`);
    return;
  }
  if (!eleven.configured)
    throw new Error(
      "Narration is blocked: set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID, supply --audio-dir, or use --scratch for timing only",
    );
  if (!args.flags.yes)
    throw new Error(
      `Paid generation is opt-in: this would request ${cache.missing.length} scene(s), ${cache.missing.reduce((sum, scene) => sum + scene.narration.length, 0)} characters. Re-run with --yes to confirm.`,
    );
  await generateWithElevenLabs(selected, env, overrides, "elevenlabs");
  log("Narration generated with ElevenLabs and alignment saved.");
}

function requireNarrationEnvSafe(env: Record<string, string | undefined>): {
  configured: boolean;
  voiceId: string;
  modelId: string;
} {
  const voiceId = env.ELEVENLABS_VOICE_ID ?? "";
  const configured = Boolean(env.ELEVENLABS_API_KEY && voiceId);
  return {
    configured,
    voiceId: voiceId || "unconfigured-voice",
    modelId: env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
  };
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:voice failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
