import { type AnyZodObject, Composition, registerRoot } from "remotion";
import { HackathonVideo } from "./compositions/HackathonVideo.tsx";
import { type HackathonVideoProps, nominalProps } from "./lib/props.ts";

/**
 * Remotion entry point. `bun run video:timeline` produces the measured timeline
 * that render/preview pass as input props; the nominal props keep Studio usable
 * before any asset exists.
 */
export function RemotionRoot() {
  return (
    <Composition<AnyZodObject, HackathonVideoProps>
      id="HackathonVideo"
      component={HackathonVideo}
      durationInFrames={nominalProps().timeline.totalFrames}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={nominalProps()}
      calculateMetadata={({ props }) => ({
        durationInFrames: props.timeline.totalFrames,
        fps: props.timeline.fps,
        width: props.timeline.width,
        height: props.timeline.height,
      })}
    />
  );
}

registerRoot(RemotionRoot);
