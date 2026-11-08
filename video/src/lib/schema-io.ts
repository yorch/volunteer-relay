import { readFileSync } from "node:fs";
import { parseSceneManifest, type SceneManifest } from "./schema.ts";

/**
 * Filesystem access for the scene manifest. Kept out of schema.ts so the
 * composition bundle never pulls `node:fs` into the browser.
 */
export function loadSceneManifest(path: string): SceneManifest {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Cannot read the scene manifest at ${path}: ${(error as Error).message}`,
    );
  }
  return parseSceneManifest(raw);
}
