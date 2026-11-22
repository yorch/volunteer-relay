import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Card } from "../lib/schema.ts";
import { theme, typography } from "../theme.ts";

/**
 * Composed information card. Used where a claim cannot be read off the UI in
 * time — it needs no element alignment, so it survives re-captures.
 */
export function InfoCard({ cards }: { cards: readonly Card[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const active = cards.find(
    (card) =>
      seconds >= card.atSeconds && seconds < card.atSeconds + card.holdSeconds,
  );
  if (!active) return null;
  const enter = spring({
    frame: frame - Math.round(active.atSeconds * fps),
    fps,
    config: { damping: 200, mass: 0.7 },
  });
  const remaining = active.atSeconds + active.holdSeconds - seconds;
  const exit = interpolate(remaining, [0, 0.25], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: Math.min(enter, exit),
      }}
    >
      <div
        style={{
          minWidth: 760,
          padding: "38px 54px",
          borderRadius: 22,
          background: "rgba(13, 32, 27, 0.94)",
          border: `3px solid ${theme.teal}`,
          boxShadow: "0 26px 70px rgba(6, 18, 14, 0.45)",
          transform: `translateY(${(1 - enter) * 16}px)`,
          fontFamily: typography.display,
          color: theme.captionText,
          textAlign: "center",
        }}
      >
        <div
          style={{
            fontSize: 26,
            letterSpacing: 2.6,
            textTransform: "uppercase",
            color: theme.tealWash,
            opacity: 0.85,
            marginBottom: 14,
          }}
        >
          {active.title}
        </div>
        {active.lines.map((line, index) => (
          <div
            key={line}
            style={{
              fontSize: index === 0 ? 54 : 40,
              fontWeight: index === 0 ? 800 : 600,
              lineHeight: 1.28,
              marginTop: index === 0 ? 0 : 10,
              opacity: index === 0 ? 1 : 0.9,
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
