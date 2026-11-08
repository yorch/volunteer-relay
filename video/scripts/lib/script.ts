import { existsSync, readFileSync } from "node:fs";
import { normalizeSpeech } from "../../src/lib/captions.ts";
import { runOrThrow } from "../../src/lib/cli.ts";
import { loadEnv, paths, requireEnv } from "../../src/lib/env.ts";
import { loadExpectedResults, loadScenario } from "../../src/lib/scenario.ts";
import type { Scene } from "../../src/lib/schema.ts";
import { loadSceneManifest } from "../../src/lib/schema-io.ts";

/**
 * Narration script parsing and cost estimation. The readable script and the
 * machine-readable manifest must agree word for word.
 */

export function narrationFromScript(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  const blocks = markdown.split(/^## /m).slice(1);
  for (const block of blocks) {
    const heading = block.split("\n", 1)[0] ?? "";
    const id = /^(S\d{2})/.exec(heading)?.[1];
    if (!id) continue;
    // Production notes always follow the spoken paragraph and start with
    // "On screen:"; they are never read aloud.
    const lines: string[] = [];
    for (const line of block.split("\n").slice(1)) {
      if (line.startsWith("On screen:")) break;
      lines.push(line);
    }
    const body = lines.join(" ").replace(/^#+ .*$/gm, "");
    sections.set(id, normalizeSpeech(body.replace(/\s+/g, " ")));
  }
  return sections;
}

export function assertScriptInSync(
  markdown: string,
  scenes: readonly Scene[],
): void {
  const fromScript = narrationFromScript(markdown);
  const problems: string[] = [];
  for (const scene of scenes) {
    const spoken = fromScript.get(scene.id);
    if (!spoken) {
      problems.push(
        `${scene.id} has no narration section in narration/script.md`,
      );
      continue;
    }
    if (spoken !== normalizeSpeech(scene.narration))
      problems.push(
        `${scene.id} narration differs between scenes.json and narration/script.md`,
      );
  }
  if (problems.length)
    throw new Error(`Narration script drift:\n  ${problems.join("\n  ")}`);
}

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function scriptStats(scenes: readonly Scene[]): {
  words: number;
  characters: number;
  perScene: Array<{ id: string; words: number; characters: number }>;
} {
  return {
    words: scenes.reduce((sum, scene) => sum + countWords(scene.narration), 0),
    characters: scenes.reduce((sum, scene) => sum + scene.narration.length, 0),
    perScene: scenes.map((scene) => ({
      id: scene.id,
      words: countWords(scene.narration),
      characters: scene.narration.length,
    })),
  };
}

export function loadEverything() {
  const env = loadEnv();
  const manifest = loadSceneManifest(paths.scenes);
  const scenario = loadScenario(paths.scenario);
  const expected = loadExpectedResults(paths.expectedResults);
  const script = readFileSync(`${paths.videoRoot}/narration/script.md`, "utf8");
  assertScriptInSync(script, manifest.scenes);
  return { env, manifest, scenario, expected, script };
}

export function requireNarrationEnv(env: Record<string, string | undefined>): {
  apiKey: string;
  voiceId: string;
  modelId: string;
} {
  return {
    apiKey: requireEnv(env, "ELEVENLABS_API_KEY"),
    voiceId: requireEnv(env, "ELEVENLABS_VOICE_ID"),
    modelId: env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2",
  };
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

export function gitHead(): string {
  return runOrThrow("git", ["rev-parse", "--short", "HEAD"], {
    cwd: paths.repoRoot,
  }).trim();
}
