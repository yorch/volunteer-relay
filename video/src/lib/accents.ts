/**
 * Sparse UI accents. Only deliberate, meaningful beats get a sound: a click when
 * a shot's interaction starts and a confirm when a decision is recorded. Marker
 * labels come from the capture manifest, so the sound is tied to a real action.
 */

export type AccentKind = "click" | "confirm";

export interface AccentCue {
  atFrame: number;
  kind: AccentKind;
}

const CONFIRM = /accepted|rejected|assigned|acknowledged|updated|filtered/i;
const CLICK =
  /opened|verified|visible|inbox-ready|needs-board|proposal-open|duplicate-open/i;

export function accentKindFor(label: string): AccentKind | null {
  if (CONFIRM.test(label)) return "confirm";
  if (CLICK.test(label)) return "click";
  return null;
}

/** One accent per beat, de-duplicated per second, in programme frames. */
export function accentCues(
  scenes: ReadonlyArray<{
    startFrame: number;
    markers: ReadonlyArray<{ label: string; atSeconds: number }>;
  }>,
  fps: number,
  maxCues = 12,
): AccentCue[] {
  const cues: AccentCue[] = [];
  const seen = new Set<string>();
  for (const scene of scenes) {
    for (const marker of scene.markers) {
      const kind = accentKindFor(marker.label);
      if (!kind) continue;
      const atFrame = scene.startFrame + Math.round(marker.atSeconds * fps);
      const bucket = `${kind}:${Math.round(atFrame / fps)}`;
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      cues.push({ atFrame, kind });
      if (cues.length >= maxCues) return cues;
    }
  }
  return cues;
}
