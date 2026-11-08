import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { focusCss, focusTransform } from "../lib/focus-transform.ts";
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
  const transform = focusTransform(frame / fps, focus);
  const css = focusCss(transform);
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
            transform: css,
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
