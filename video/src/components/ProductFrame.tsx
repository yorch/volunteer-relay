import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Focus } from "../lib/schema.ts";
import { theme, typography } from "../theme.ts";

/**
 * Genuine application footage. The capture is 1920x1080; gentle focus pushes
 * keep the source capture space so crops never desynchronise. A small origin
 * label stays visible for the whole scene.
 */
export function ProductFrame({
  captureFile,
  focus,
  disclosure,
  origin,
  missing,
}: {
  captureFile: string | null;
  focus: readonly Focus[];
  disclosure: string | null;
  origin: "hosted" | "local" | "none";
  missing: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const active = focus.find(
    (target) =>
      seconds >= target.atSeconds &&
      seconds < target.atSeconds + target.holdSeconds,
  );
  let scale = 1;
  let translateX = 0;
  let translateY = 0;
  if (active) {
    const elapsed = seconds - active.atSeconds;
    const remaining = active.atSeconds + active.holdSeconds - seconds;
    const ramp = Math.min(
      1,
      Math.max(0, elapsed / 1.2, remaining < 1.2 ? remaining / 1.2 : 1),
    );
    const eased = ramp * ramp * (3 - 2 * ramp);
    scale = 1 + (active.scale - 1) * eased;
    translateX = (0.5 - active.x) * 100 * active.scale * eased;
    translateY = (0.5 - active.y) * 100 * active.scale * eased;
  }
  return (
    <AbsoluteFill style={{ background: theme.ink }}>
      {missing || !captureFile ? (
        <AbsoluteFill
          style={{
            alignItems: "center",
            justifyContent: "center",
            color: theme.background,
            fontFamily: typography.display,
            fontSize: 46,
            textAlign: "center",
            padding: 120,
          }}
        >
          Capture missing — run bun run video:capture before rendering.
        </AbsoluteFill>
      ) : (
        <AbsoluteFill
          style={{
            transform: `translate(${translateX}%, ${translateY}%) scale(${scale})`,
          }}
        >
          <OffthreadVideo
            src={staticFile(captureFile)}
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </AbsoluteFill>
      )}
      {disclosure ? (
        <div
          style={{
            position: "absolute",
            top: 22,
            right: 26,
            padding: "6px 14px",
            borderRadius: 999,
            background: "rgba(16, 38, 31, 0.78)",
            color: theme.captionText,
            fontFamily: typography.body,
            fontSize: 20,
            letterSpacing: 0.3,
          }}
        >
          {disclosure}
          {origin === "none" ? "" : ` · ${origin} capture`}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}
