import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { paths } from "./env.ts";
import { finalRenderProblems } from "./readiness.ts";
import { parseSceneManifest } from "./schema.ts";
import { buildTimeline } from "./timeline.ts";

const manifest = parseSceneManifest(
  JSON.parse(readFileSync(paths.scenes, "utf8")),
);
const timeline = buildTimeline(
  manifest,
  manifest.scenes.map((scene) => ({
    id: scene.id,
    kind: scene.kind,
    minSeconds: scene.minSeconds,
    maxSeconds: scene.maxSeconds,
    narrationSeconds: scene.minSeconds - 1,
    footageSeconds: scene.minSeconds + 3,
    narrationSource: "elevenlabs" as const,
  })),
);
const productIds = manifest.scenes
  .filter((scene) => scene.kind === "product")
  .map((scene) => scene.id);
const narration = timeline.scenes.map((scene) => ({
  sceneId: scene.id,
  durationSeconds: scene.narrationSeconds ?? 0,
  source: "elevenlabs",
}));

function ready(
  overrides: Partial<Parameters<typeof finalRenderProblems>[0]> = {},
) {
  return {
    timeline,
    productScenes: productIds,
    capturedSceneIds: productIds,
    captureOrigins: productIds.map(() => "https://volunteer-relay.brnby.com"),
    currentNarration: narration,
    captionedSceneIds: timeline.scenes.map((scene) => scene.id),
    hasMusic: false,
    ...overrides,
  };
}

describe("final render readiness", () => {
  it("passes a complete, single-origin programme", () => {
    expect(finalRenderProblems(ready())).toEqual([]);
  });

  it("blocks scratch narration found on disk, whatever the timeline says", () => {
    const problems = finalRenderProblems(
      ready({
        currentNarration: narration.map((asset) => ({
          ...asset,
          source: "scratch-local-voice",
        })),
      }),
    ).join(" ");
    expect(problems).toMatch(/scratch voice/);
  });

  it("blocks narration that changed after the timeline was built", () => {
    const problems = finalRenderProblems(
      ready({
        currentNarration: narration.map((asset, index) =>
          index === 2
            ? { ...asset, durationSeconds: asset.durationSeconds + 3 }
            : asset,
        ),
      }),
    ).join(" ");
    expect(problems).toMatch(/rerun video:timeline/);
  });

  it("blocks a scene with no narration file or no captions", () => {
    const missingAudio = finalRenderProblems(
      ready({ currentNarration: narration.slice(1) }),
    ).join(" ");
    expect(missingAudio).toMatch(/no narration file/);

    const missingCues = finalRenderProblems(
      ready({ captionedSceneIds: productIds.slice(0, 1) }),
    ).join(" ");
    expect(missingCues).toMatch(/no captions for/);
  });

  it("blocks missing captures and mixed origins", () => {
    const problems = finalRenderProblems(
      ready({
        capturedSceneIds: productIds.slice(0, 2),
        captureOrigins: [
          "http://127.0.0.1:3300",
          "https://volunteer-relay.brnby.com",
        ],
      }),
    ).join(" ");
    expect(problems).toMatch(/missing captures/);
    expect(problems).toMatch(/mixed capture origins/);
  });
});
