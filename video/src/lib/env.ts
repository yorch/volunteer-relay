import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Explicit environment loading for video tooling. Credentials live only in the
 * ignored `video/.env.local` (or the runner's secret store); exported process
 * variables take precedence. Values are never printed by these helpers.
 */

export const videoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const paths = {
  videoRoot,
  repoRoot,
  scenes: join(videoRoot, "scenes.json"),
  scenario: join(videoRoot, "fixtures", "recording-scenario.json"),
  expectedResults: join(videoRoot, "fixtures", "expected-results.json"),
  envLocal: join(videoRoot, ".env.local"),
  envExample: join(videoRoot, ".env.example"),
  authDir: join(videoRoot, ".auth"),
  generated: join(videoRoot, "generated"),
  narration: join(videoRoot, "generated", "narration"),
  alignments: join(videoRoot, "generated", "alignments"),
  captures: join(videoRoot, "generated", "captures"),
  timeline: join(videoRoot, "generated", "timeline.json"),
  captureManifest: join(videoRoot, "generated", "capture-manifest.json"),
  captions: join(videoRoot, "generated", "captions"),
  output: join(videoRoot, "output"),
} as const;

export const requiredEnvNames = [
  "VIDEO_BASE_URL",
  "VIDEO_TARGET_MODE",
  "VIDEO_ALLOWED_ORIGIN",
  "VIDEO_ORGANIZATION_ID",
  "VIDEO_SECONDARY_ORGANIZATION_ID",
  "VIDEO_OPERATOR_EMAIL",
  "VIDEO_OPERATOR_PASSWORD",
  "VIDEO_BOARD_EMAIL",
  "VIDEO_BOARD_PASSWORD",
  "VIDEO_CASEY_EMAIL",
  "VIDEO_CASEY_PASSWORD",
  "VIDEO_SCENARIO_RUN_ID",
  "VIDEO_OWEN_EMAIL",
  "VIDEO_OWEN_PASSWORD",
  "VIDEO_MARISOL_EMAIL",
  "VIDEO_MARISOL_PASSWORD",
  "VIDEO_SOFIA_EMAIL",
  "VIDEO_SOFIA_PASSWORD",
  "VIDEO_ANA_EMAIL",
  "VIDEO_ANA_PASSWORD",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_VOICE_ID",
  "ELEVENLABS_MODEL_ID",
] as const;

export type EnvName = (typeof requiredEnvNames)[number];

export type VideoEnv = Record<string, string | undefined>;

export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

export function loadEnv(
  processEnv: VideoEnv = process.env,
  envFile = paths.envLocal,
): VideoEnv {
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseEnvFile(readFileSync(envFile, "utf8"));
  } catch {
    fromFile = {};
  }
  return { ...fromFile, ...processEnv };
}

export function readEnv(key: string): string | undefined {
  const value = loadEnv()[key];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function requireEnv(env: VideoEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "")
    throw new Error(
      `Missing ${key}. Copy video/.env.example to video/.env.local and fill it in.`,
    );
  return value;
}

/** Reported by the doctor; never returns or logs secret values. */
export function describeEnv(env: VideoEnv): {
  configured: string[];
  missing: string[];
} {
  const configured: string[] = [];
  const missing: string[] = [];
  for (const name of requiredEnvNames) {
    const value = env[name];
    if (value === undefined || value.trim() === "") missing.push(name);
    else configured.push(name);
  }
  return { configured, missing };
}

export const secretEnvNames = requiredEnvNames.filter((name) =>
  name.endsWith("_PASSWORD"),
);

export function isSecret(name: string): boolean {
  return secretEnvNames.includes(name as EnvName) || name.includes("API_KEY");
}

/** Fail closed if a manifest accidentally embeds a credential. */
export function assertNoSecrets(value: unknown, where: string): void {
  const text = JSON.stringify(value);
  for (const name of requiredEnvNames) {
    const secret = loadEnv()[name];
    if (isSecret(name) && secret && secret.length >= 6 && text.includes(secret))
      throw new Error(`${where} contains the value of ${name}`);
  }
}
