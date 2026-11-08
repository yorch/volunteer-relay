import type { Focus } from "./schema.ts";

/**
 * Ken-Burns push for one frame. The zoom is anchored on the focus point via
 * `transform-origin` and never translated: translating a full-frame video always
 * exposes the edge (centring a left-side point needs a scale of 0.5/x), which is
 * exactly the dark band this replaced. Annotation layers use the same transform
 * so recorded boxes stay aligned with the footage.
 */
export interface FocusTransform {
  scale: number;
  /** Transform origin, normalised within the frame. */
  originX: number;
  originY: number;
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
  if (!active) return { scale: 1, originX: 0.5, originY: 0.5 };

  const elapsed = seconds - active.atSeconds;
  const remaining = active.atSeconds + active.holdSeconds - seconds;
  // Fade in over 1.2s and out over the last 1.2s, so pushes settle softly.
  const ramp = Math.min(
    1,
    Math.max(0, elapsed) / 1.2,
    Math.max(0, remaining) / 1.2,
  );
  const eased = ramp * ramp * (3 - 2 * ramp);
  const target = Math.min(MAX_FOCUS_SCALE, Math.max(1, active.scale));

  return {
    scale: 1 + (target - 1) * eased,
    originX: active.x,
    originY: active.y,
  };
}

/** CSS transform string shared by the footage and the annotation layer. */
export function focusCss(transform: FocusTransform): string {
  return `scale(${transform.scale})`;
}

/** Matching `transform-origin`. */
export function focusOrigin(transform: FocusTransform): string {
  return `${transform.originX * 100}% ${transform.originY * 100}%`;
}
