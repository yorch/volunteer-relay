import { useCurrentFrame, useVideoConfig } from "remotion";
import { Callout } from "../components/Callout.tsx";
import { ProductFrame } from "../components/ProductFrame.tsx";
import { Spotlight } from "../components/Spotlight.tsx";
import {
  focusCss,
  focusOrigin,
  focusTransform,
} from "../lib/focus-transform.ts";
import type { HackathonVideoProps } from "../lib/props.ts";
import type { Scene } from "../lib/schema.ts";

/** A product scene is genuine captured application footage plus restrained art direction. */
export function ProductScene({
  scene,
  props,
}: {
  scene: Scene;
  props: HackathonVideoProps;
}) {
  if (scene.capture === null)
    throw new Error(`${scene.id} is a product scene without a capture plan`);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Annotations live in capture space, so they move with the footage.
  const annotationFocus = focusTransform(frame / fps, scene.focus);
  const annotationTransform = focusCss(annotationFocus);
  const annotationOrigin = focusOrigin(annotationFocus);
  const captureFile = props.captureFiles[scene.id] ?? null;
  const available = props.assets.captures && captureFile !== null;
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000" }}>
      <ProductFrame
        captureFile={available ? captureFile : null}
        focus={scene.focus}
        disclosure={scene.onScreenDisclosure}
        origin={props.captureOrigins[scene.id] ?? "none"}
        missing={!available}
      />
      <Callout overlays={scene.overlays} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: annotationTransform,
          transformOrigin: annotationOrigin,
        }}
      >
        {scene.annotations.map((annotation) => {
          const box = props.captureRegions[scene.id]?.[annotation.region];
          if (!box) return null;
          return (
            <Spotlight
              key={`${annotation.region}-${annotation.atSeconds}`}
              box={box}
              atSeconds={annotation.atSeconds}
              holdSeconds={annotation.holdSeconds}
              label={annotation.label}
            />
          );
        })}
      </div>
    </div>
  );
}
