import { z } from "zod";

/**
 * Typed, validated scene manifest. The manifest is the editorial source of
 * truth: narration text, the application state each scene records, overlays and
 * focus targets. It never contains credentials, ids of real people or provider
 * keys. Measured durations live in the generated timeline instead.
 */

const durationSeconds = z
  .number()
  .finite()
  .positive()
  .max(600, "A scene cannot be longer than ten minutes");

export const overlaySchema = z
  .object({
    text: z.string().min(1).max(120),
    atSeconds: z.number().finite().nonnegative(),
    holdSeconds: durationSeconds,
  })
  .strict();

export const focusSchema = z
  .object({
    /** Normalized centre of the focus window within the source capture. */
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    /** 1 renders the capture at its natural size; 2 doubles it. */
    scale: z.number().min(1).max(3),
    atSeconds: z.number().finite().nonnegative(),
    holdSeconds: durationSeconds,
  })
  .strict();

export const capturePlanSchema = z
  .object({
    /** Stable checkpoint id proved by an application-state assertion. */
    checkpointId: z.string().min(1),
    /** Role that owns the browser session for this scene. */
    role: z.enum(["coordinator", "volunteer", "owner", "report-reader"]),
    route: z.string().startsWith("/"),
    /** Readiness marker that must be visible before recording starts. */
    readyText: z.string().min(1),
  })
  .strict();

export const sceneSchema = z
  .object({
    id: z
      .string()
      .regex(/^S\d{2}$/, "Scene ids look like S01")
      .describe("Stable scene id used by captures, assets and captions"),
    title: z.string().min(1).max(80),
    /** Graphic scenes are designed motion graphics; product scenes must show captured application footage. */
    kind: z.enum(["graphic", "product"]),
    narration: z.string().min(1),
    onScreenDisclosure: z.string().min(1).nullable(),
    capture: capturePlanSchema.nullable(),
    overlays: z.array(overlaySchema).max(6),
    focus: z.array(focusSchema).max(4),
    minSeconds: durationSeconds,
    maxSeconds: durationSeconds,
  })
  .strict()
  .superRefine((scene, ctx) => {
    if (scene.kind === "product" && scene.capture === null)
      ctx.addIssue({
        code: "custom",
        message: `${scene.id} is a product scene and needs a capture plan`,
        path: ["capture"],
      });
    if (scene.kind === "graphic" && scene.capture !== null)
      ctx.addIssue({
        code: "custom",
        message: `${scene.id} is a graphic scene and must not claim a capture`,
        path: ["capture"],
      });
    if (scene.minSeconds > scene.maxSeconds)
      ctx.addIssue({
        code: "custom",
        message: `${scene.id} minSeconds exceeds maxSeconds`,
        path: ["minSeconds"],
      });
  });

export const sceneManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    fps: z.literal(30),
    width: z.literal(1920),
    height: z.literal(1080),
    targetSeconds: durationSeconds,
    maxSeconds: durationSeconds,
    scenes: z.array(sceneSchema).min(1).max(32),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    for (const [index, scene] of manifest.scenes.entries()) {
      if (seen.has(scene.id))
        ctx.addIssue({
          code: "custom",
          message: `Duplicate scene id ${scene.id}`,
          path: ["scenes", index, "id"],
        });
      seen.add(scene.id);
    }
    const floor = manifest.scenes.reduce(
      (total, scene) => total + scene.minSeconds,
      0,
    );
    if (floor > manifest.maxSeconds)
      ctx.addIssue({
        code: "custom",
        message: `Minimum scene durations (${floor}s) exceed the delivery limit`,
        path: ["scenes"],
      });
    if (manifest.targetSeconds > manifest.maxSeconds)
      ctx.addIssue({
        code: "custom",
        message: "targetSeconds exceeds maxSeconds",
        path: ["targetSeconds"],
      });
  });

export type Scene = z.infer<typeof sceneSchema>;
export type SceneManifest = z.infer<typeof sceneManifestSchema>;
export type Overlay = z.infer<typeof overlaySchema>;
export type Focus = z.infer<typeof focusSchema>;
export type CapturePlan = z.infer<typeof capturePlanSchema>;

export function parseSceneManifest(value: unknown): SceneManifest {
  const result = sceneManifestSchema.safeParse(value);
  if (!result.success)
    throw new Error(
      `Invalid scene manifest:\n${result.error.issues
        .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  return result.data;
}

export function sceneById(manifest: SceneManifest, sceneId: string): Scene {
  const scene = manifest.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) throw new Error(`Unknown scene ${sceneId}`);
  return scene;
}

export function productScenes(
  manifest: SceneManifest,
): Array<Scene & { capture: CapturePlan }> {
  return manifest.scenes.filter(
    (scene): scene is Scene & { capture: CapturePlan } =>
      scene.capture !== null,
  );
}
