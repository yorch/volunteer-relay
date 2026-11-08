import type { Focus } from "./schema.ts";

/**
 * Ken-Burns transform for one frame. The content is translated toward the focus
 * point and scaled enough that the translated frame still covers the viewport
 * (a bare translate would expose the background), then capped so pushes stay
 * gentle. Annotations use the same transform so recorded boxes stay aligned.
 */
export interface FocusTransform {
  scale: number;
  /** Fraction of the frame width/height. */
  tx: number;
  ty: number;
}

export const MAX_FOCUS_SCALE = 1.45;

export function focusTransform(
  seconds: number,
  focus: readonly Focus[],
): FocusTransform {
  const active = focus.find(
    (target) =>
      seconds >= target.atSeconds &&
      seconds < target.atSeconds + target.holdSeconds,
  );
  if (!active) return { scale: 1, tx: 0, ty: 0 };

  const elapsed = seconds - active.atSeconds;
  const remaining = active.atSeconds + active.holdSeconds - seconds;
  // Fade in over 1.2s and out over the last 1.2s, so pushes settle softly.
  const ramp = Math.min(
    1,
    Math.max(0, elapsed) / 1.2,
    Math.max(0, remaining) / 1.2,
  );
  const eased = ramp * ramp * (3 - 2 * ramp);

  const tx = 0.5 - active.x;
  const ty = 0.5 - active.y;
  const coverage = 1 + Math.max(Math.abs(tx), Math.abs(ty));
  const target = Math.min(MAX_FOCUS_SCALE, Math.max(active.scale, coverage));

  return {
    scale: 1 + (target - 1) * eased,
    tx: tx * eased,
    ty: ty * eased,
  };
}

/** CSS transform string shared by the footage and the annotation layer. */
export function focusCss(transform: FocusTransform): string {
  return `translate(${transform.tx * 100}%, ${transform.ty * 100}%) scale(${transform.scale})`;
}
