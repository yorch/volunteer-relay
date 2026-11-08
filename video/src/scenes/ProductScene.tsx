import { Callout } from "../components/Callout.tsx";
import { ProductFrame } from "../components/ProductFrame.tsx";
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
  const captureFile = props.captureFiles[scene.id] ?? null;
  const available = props.assets.captures && captureFile !== null;
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000" }}>
      <ProductFrame
        captureFile={available ? captureFile : null}
        focus={scene.focus}
        disclosure={scene.onScreenDisclosure}
        origin={props.captureOrigin}
        missing={!available}
      />
      <Callout overlays={scene.overlays} />
    </div>
  );
}
