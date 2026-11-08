import type { Scene } from "./schema.ts";

/**
 * Which scenes a paid run may request. A cache hit (same text, provider, model,
 * voice, settings and pronunciations, with the file present) must never be
 * requested again unless the caller explicitly forces a regeneration.
 */
export function scenesToGenerate(input: {
  selected: readonly Scene[];
  cacheHits: readonly Scene[];
  force: boolean;
}): Scene[] {
  if (input.force) return [...input.selected];
  const hitIds = new Set(input.cacheHits.map((scene) => scene.id));
  return input.selected.filter((scene) => !hitIds.has(scene.id));
}
