import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "./env.ts";
import { parseSceneManifest, productScenes } from "./schema.ts";

const raw = JSON.parse(readFileSync(paths.scenes, "utf8")) as unknown;

describe("scene manifest", () => {
  it("validates the committed manifest", () => {
    const manifest = parseSceneManifest(raw);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fps).toBe(30);
    expect(manifest.width).toBe(1920);
    expect(manifest.height).toBe(1080);
    expect(manifest.maxSeconds).toBeLessThanOrEqual(180);
    expect(manifest.scenes.map((scene) => scene.id)).toEqual([
      "S01",
      "S02",
      "S03",
      "S04",
      "S05",
      "S06",
      "S07",
      "S08",
    ]);
  });

  it("requires capture plans on product scenes and none on graphics", () => {
    const manifest = parseSceneManifest(raw);
    for (const scene of manifest.scenes) {
      if (scene.kind === "product") expect(scene.capture).not.toBeNull();
      else expect(scene.capture).toBeNull();
    }
    expect(productScenes(manifest).map((scene) => scene.id)).toEqual([
      "S02",
      "S03",
      "S04",
      "S05",
      "S06",
      "S07",
    ]);
  });

  it("rejects a product scene without a capture plan", () => {
    const broken = structuredClone(raw) as {
      scenes: Array<Record<string, unknown>>;
    };
    const scene = broken.scenes[1];
    if (scene) scene.capture = null;
    expect(() => parseSceneManifest(broken)).toThrow(/needs a capture plan/);
  });

  it("rejects duplicate scene ids", () => {
    const broken = structuredClone(raw) as { scenes: unknown[] };
    broken.scenes.push(structuredClone(broken.scenes[0]));
    expect(() => parseSceneManifest(broken)).toThrow(/Duplicate scene id/);
  });

  it("rejects a manifest whose minimum durations exceed the limit", () => {
    const broken = structuredClone(raw) as {
      scenes: Array<{ minSeconds: number }>;
      maxSeconds: number;
    };
    for (const scene of broken.scenes) scene.minSeconds = 40;
    expect(() => parseSceneManifest(broken)).toThrow(
      /exceed the delivery limit/,
    );
  });

  it("keeps every scene inside the delivery limit on its own", () => {
    const manifest = parseSceneManifest(raw);
    for (const scene of manifest.scenes) {
      expect(scene.minSeconds).toBeLessThanOrEqual(scene.maxSeconds);
      expect(scene.maxSeconds).toBeLessThanOrEqual(manifest.maxSeconds);
    }
  });
});
