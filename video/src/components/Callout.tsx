import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Overlay } from "../lib/schema.ts";
import { theme, typography } from "../theme.ts";

/**
 * Restrained callouts. They appear in the upper-left safe area, hold still for
 * reading, and never cover the centre of the frame where evidence lives.
 */
export function Callout({ overlays }: { overlays: readonly Overlay[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const active = overlays.find(
    (overlay) =>
      seconds >= overlay.atSeconds &&
      seconds < overlay.atSeconds + overlay.holdSeconds,
  );
  if (!active) return null;
  const elapsed = seconds - active.atSeconds;
  const opacity = interpolate(elapsed, [0, 0.25], [0, 1], {
    extrapolateRight: "clamp",
  });
  const translate = interpolate(elapsed, [0, 0.35], [14, 0], {
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        top: 84,
        right: 26,
        opacity,
        transform: `translateY(${translate}px)`,
        background: theme.surface,
        color: theme.ink,
        border: `2px solid ${theme.teal}`,
        borderRadius: 12,
        padding: "14px 22px",
        fontFamily: typography.display,
        fontSize: 34,
        fontWeight: 700,
        letterSpacing: 0.2,
        boxShadow: "0 10px 28px rgba(16, 38, 31, 0.16)",
        maxWidth: 720,
        textAlign: "left",
      }}
    >
      {active.text}
    </div>
  );
}
