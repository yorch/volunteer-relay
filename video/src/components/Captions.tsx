import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { Cue } from "../lib/captions.ts";
import { wrapCue } from "../lib/captions.ts";
import { theme, typography } from "../theme.ts";

/**
 * Burned-in phrase captions. Cues are absolute programme time and stay inside
 * the reserved lower safe area so they never cover the evidence being shown.
 */
export function Captions({ cues }: { cues: readonly Cue[] }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const active = cues.find(
    (cue) => seconds >= cue.startSeconds && seconds < cue.endSeconds,
  );
  if (!active) return null;
  const elapsed = seconds - active.startSeconds;
  const remaining = active.endSeconds - seconds;
  const opacity = Math.min(1, elapsed / 0.12, remaining / 0.12);
  const lines = wrapCue(active.text);
  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 34,
      }}
    >
      <div
        style={{
          maxWidth: 1360,
          opacity,
          background: theme.captionBackground,
          color: theme.captionText,
          borderRadius: 14,
          padding: "16px 30px",
          fontFamily: typography.body,
          fontSize: 40,
          lineHeight: 1.22,
          fontWeight: 500,
          textAlign: "center",
          letterSpacing: 0.2,
        }}
      >
        {lines.map((line) => (
          <div key={line}>{line}</div>
        ))}
      </div>
    </AbsoluteFill>
  );
}
