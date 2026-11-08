import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeJson } from "../../src/lib/cli.ts";
import { paths } from "../../src/lib/env.ts";
import { narrationSourceSchema } from "../../src/lib/timeline.ts";

/**
 * Asset manifests. Every artifact records the origin it came from, so hosted and
 * local footage can never be silently mixed in one delivery.
 */

export const narrationAssetSchema = z
  .object({
    sceneId: z.string(),
    file: z.string(),
    durationSeconds: z.number().positive(),
    source: narrationSourceSchema,
    cacheKey: z.string().length(64).nullable(),
    generatedAt: z.string(),
  })
  .strict();
export type NarrationAsset = z.infer<typeof narrationAssetSchema>;

export const narrationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    provider: z.string(),
    voiceId: z.string().nullable(),
    modelId: z.string().nullable(),
    generatedAt: z.string(),
    scenes: z.array(narrationAssetSchema),
  })
  .strict();
export type NarrationManifest = z.infer<typeof narrationManifestSchema>;

export const captureAssetSchema = z
  .object({
    sceneId: z.string(),
    file: z.string(),
    durationSeconds: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive().nullable(),
    origin: z.enum(["hosted", "local"]),
    appCommit: z.string().nullable(),
    scenarioId: z.string(),
    checkpointId: z.string(),
    role: z.string(),
    recordedAt: z.string(),
    markers: z.array(
      z
        .object({ label: z.string(), atSeconds: z.number().nonnegative() })
        .strict(),
    ),
  })
  .strict();
export type CaptureAsset = z.infer<typeof captureAssetSchema>;

export const captureManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string(),
    targetMode: z.enum(["hosted", "local"]),
    baseUrl: z.string(),
    appCommit: z.string().nullable(),
    capturedAt: z.string(),
    scenes: z.array(captureAssetSchema),
  })
  .strict();
export type CaptureManifest = z.infer<typeof captureManifestSchema>;

export function timelinePath(): string {
  return paths.timeline;
}

export function captureManifestPath(): string {
  return paths.captureManifest;
}

export function narrationManifestPath(): string {
  return join(paths.narration, "manifest.json");
}

export function narrationFile(sceneId: string): string {
  return join(paths.narration, `${sceneId}.mp3`);
}

export function narrationPublicPath(sceneId: string): string {
  return `narration/${sceneId}.mp3`;
}

export function alignmentFile(sceneId: string): string {
  return join(paths.alignments, `${sceneId}.json`);
}

/** Raw recorder output, then the normalised mezzanine used by the composition. */
export function captureRawPath(sceneId: string): string {
  return join(paths.captures, `${sceneId}.webm`);
}

export function captureMezzaninePath(sceneId: string): string {
  return join(paths.captures, `${sceneId}.mp4`);
}

export function capturePublicPath(sceneId: string): string {
  const mezzanine = captureMezzaninePath(sceneId);
  return `captures/${sceneId}.${existsSync(mezzanine) ? "mp4" : "webm"}`;
}

export function readCaptureManifest(): CaptureManifest | null {
  const path = captureManifestPath();
  if (!existsSync(path)) return null;
  const parsed = captureManifestSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success)
    throw new Error(`Invalid capture manifest: ${parsed.error.message}`);
  return parsed.data;
}

export function writeCaptureManifest(manifest: CaptureManifest): void {
  writeJson(captureManifestPath(), manifest);
}

export function readNarrationManifest(): NarrationManifest | null {
  const path = narrationManifestPath();
  if (!existsSync(path)) return null;
  const parsed = narrationManifestSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success)
    throw new Error(`Invalid narration manifest: ${parsed.error.message}`);
  return parsed.data;
}

export function writeNarrationManifest(manifest: NarrationManifest): void {
  writeJson(narrationManifestPath(), manifest);
}
