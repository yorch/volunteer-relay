import { AbsoluteFill } from "remotion";

/**
 * Unifying film treatment: a soft scrim top and bottom (so captions and
 * callouts sit on a surface) plus a barely-there grain. Keeps designed graphics
 * and captured UI in one image.
 */
const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='180' height='180' filter='url(%23n)' opacity='0.5'/></svg>\")";

export function Texture() {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, rgba(8,22,18,0.42) 0%, rgba(8,22,18,0) 16%)",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(0deg, rgba(8,22,18,0.62) 0%, rgba(8,22,18,0) 26%)",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: GRAIN,
          opacity: 0.05,
          mixBlendMode: "overlay",
        }}
      />
    </AbsoluteFill>
  );
}
