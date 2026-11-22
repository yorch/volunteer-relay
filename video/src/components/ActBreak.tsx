import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/** Short black dip at the start of a scene, so acts read as separate. */
export function ActBreak({ seconds = 0.45 }: { seconds?: number }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(
    frame / fps,
    [0, seconds * 0.55, seconds],
    [1, 1, 0],
    { extrapolateRight: "clamp" },
  );
  if (opacity <= 0) return null;
  return <AbsoluteFill style={{ background: "#081612", opacity }} />;
}
