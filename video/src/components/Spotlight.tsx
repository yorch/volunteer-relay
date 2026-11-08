import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { Box } from "../lib/schema.ts";
import { theme, typography } from "../theme.ts";

/**
 * Dims everything except one recorded element and labels it. Coordinates are
 * normalised against the source capture, so the box stays aligned under any
 * focus push. The caption band stays untouched (it renders above this layer).
 */
export function Spotlight({
  box,
  atSeconds,
  holdSeconds,
  label,
}: {
  box: Box;
  atSeconds: number;
  holdSeconds: number;
  label: string | null;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  if (seconds < atSeconds || seconds >= atSeconds + holdSeconds) return null;
  const elapsed = seconds - atSeconds;
  const remaining = atSeconds + holdSeconds - seconds;
  const opacity = interpolate(Math.min(elapsed, remaining), [0, 0.25], [0, 1], {
    extrapolateRight: "clamp",
  });
  const pad = 0.012;
  return (
    <div style={{ position: "absolute", inset: 0, opacity }}>
      <div
        style={{
          position: "absolute",
          left: `${(box.x - pad) * 100}%`,
          top: `${(box.y - pad) * 100}%`,
          width: `${(box.w + pad * 2) * 100}%`,
          height: `${(box.h + pad * 2) * 100}%`,
          borderRadius: 10,
          border: `3px solid ${theme.teal}`,
          boxShadow: `0 0 0 9999px rgba(8, 22, 18, 0.46), 0 8px 30px rgba(8, 22, 18, 0.28)`,
          pointerEvents: "none",
        }}
      />
      {label ? (
        <div
          style={{
            position: "absolute",
            left: `${Math.min(box.x, 0.62) * 100}%`,
            top: `${Math.max(box.y - 0.085, 0.02) * 100}%`,
            background: theme.tealDeep,
            color: theme.captionText,
            borderRadius: 8,
            padding: "7px 14px",
            fontFamily: typography.display,
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: 0.2,
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}
