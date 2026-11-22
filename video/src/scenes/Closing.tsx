import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { demoQrDataUri, demoUrl } from "../assets/qr-demo.ts";
import type { Scene } from "../lib/schema.ts";
import { theme, typography } from "../theme.ts";

const repositoryUrl = "github.com/yorch/volunteer-relay";

/**
 * S08 closing graphic. The repository URL, license and synthetic-data
 * disclosure stay on screen long enough to read; nothing here is footage.
 */
export function Closing({ scene }: { scene: Scene }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const appear = spring({ frame, fps, config: { damping: 200, mass: 0.8 } });
  const urlOpacity = interpolate(frame / fps, [1.2, 2.2], [0, 1], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(160deg, ${theme.background} 0%, ${theme.tealWash} 100%)`,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: typography.display,
        color: theme.ink,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 26,
          opacity: appear,
          transform: `translateY(${(1 - appear) * 18}px)`,
        }}
      >
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: 26,
            background: theme.tealDeep,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: theme.captionText,
            fontSize: 52,
            fontWeight: 800,
          }}
        >
          VR
        </div>
        <div style={{ fontSize: 92, fontWeight: 800, letterSpacing: -2 }}>
          Volunteer Relay
        </div>
      </div>
      <div
        style={{
          marginTop: 30,
          fontSize: 40,
          color: theme.inkSoft,
          letterSpacing: 0.4,
          opacity: appear,
        }}
      >
        Every hour counted. Every need connected.
      </div>
      <div
        style={{
          marginTop: 56,
          opacity: urlOpacity,
          display: "flex",
          alignItems: "center",
          gap: 72,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span
              style={{
                fontSize: 22,
                letterSpacing: 2.4,
                textTransform: "uppercase",
                color: theme.teal,
                fontWeight: 700,
              }}
            >
              Live demo
            </span>
            <div
              style={{
                fontFamily: typography.mono,
                fontSize: 46,
                padding: "12px 26px",
                borderRadius: 12,
                border: `3px solid ${theme.tealDeep}`,
                background: theme.surface,
                color: theme.tealDeep,
              }}
            >
              {demoUrl.replace("https://", "")}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span
              style={{
                fontSize: 20,
                letterSpacing: 2,
                textTransform: "uppercase",
                color: theme.inkSoft,
                fontWeight: 700,
              }}
            >
              Source · MIT
            </span>
            <div
              style={{
                fontFamily: typography.mono,
                fontSize: 28,
                color: theme.inkSoft,
              }}
            >
              {repositoryUrl}
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
            padding: 16,
            borderRadius: 18,
            background: theme.surface,
            border: `2px solid ${theme.line}`,
          }}
        >
          <img
            src={demoQrDataUri}
            alt="QR code for the live demo"
            width={232}
            height={232}
          />
          <span style={{ fontSize: 20, color: theme.inkSoft }}>
            Scan to try it
          </span>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 176,
          fontSize: 22,
          color: theme.inkSoft,
          letterSpacing: 0.4,
        }}
      >
        {scene.onScreenDisclosure}
      </div>
    </AbsoluteFill>
  );
}
