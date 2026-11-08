import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useVideoConfig,
} from "remotion";
import scenesJson from "../../scenes.json";
import { Captions } from "../components/Captions.tsx";
import type { HackathonVideoProps } from "../lib/props.ts";
import { parseSceneManifest } from "../lib/schema.ts";
import { Closing } from "../scenes/Closing.tsx";
import { Opening } from "../scenes/Opening.tsx";
import { ProductScene } from "../scenes/ProductScene.tsx";
import { theme } from "../theme.ts";

const manifest = parseSceneManifest(scenesJson);

/**
 * Frame-based programme. Every scene is a Sequence at an integer frame start
 * taken from the generated timeline manifest; narration audio lives inside its
 * scene so holds can be trimmed without cutting speech.
 */
export function HackathonVideo(props: HackathonVideoProps) {
  const { fps } = useVideoConfig();
  if (props.timeline.fps !== fps)
    throw new Error(
      `Timeline fps ${props.timeline.fps} does not match the composition fps ${fps}`,
    );
  return (
    <AbsoluteFill style={{ background: theme.background }}>
      {props.timeline.scenes.map((timelineScene) => {
        const scene = manifest.scenes.find(
          (candidate) => candidate.id === timelineScene.id,
        );
        if (!scene)
          throw new Error(
            `Timeline scene ${timelineScene.id} is not in the scene manifest`,
          );
        const narrationFile = props.narrationFiles[scene.id];
        return (
          <Sequence
            key={timelineScene.id}
            name={`${scene.id} ${scene.title}`}
            from={timelineScene.startFrame}
            durationInFrames={timelineScene.durationInFrames}
            layout="none"
          >
            {scene.kind === "graphic" ? (
              scene.id === "S01" ? (
                <Opening scene={scene} />
              ) : (
                <Closing scene={scene} />
              )
            ) : (
              <ProductScene scene={scene} props={props} />
            )}
            {props.assets.narration && narrationFile ? (
              <Audio src={staticFile(narrationFile)} volume={1} />
            ) : null}
          </Sequence>
        );
      })}
      {props.assets.music && props.musicFile ? (
        <Audio src={staticFile(props.musicFile)} loop volume={0.08} />
      ) : null}
      {props.assets.captions ? <Captions cues={props.cues} /> : null}
    </AbsoluteFill>
  );
}
