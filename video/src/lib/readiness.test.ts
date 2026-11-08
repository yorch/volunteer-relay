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

function ready(
  overrides: Partial<Parameters<typeof finalRenderProblems>[0]> = {},
) {
  return {
    timeline,
    productScenes: productIds,
    capturedSceneIds: productIds,
    captureOrigins: productIds.map(() => "https://volunteer-relay.brnby.com"),
    cueCount: 40,
    hasMusic: false,
    ...overrides,
  };
}

describe("final render readiness", () => {
  it("passes a complete, single-origin programme", () => {
    expect(finalRenderProblems(ready())).toEqual([]);
  });

  it("blocks scratch or absent narration", () => {
    const scratch = {
      ...timeline,
      narrationSource: "scratch-local-voice" as const,
    };
    expect(finalRenderProblems(ready({ timeline: scratch })).join(" ")).toMatch(
      /scratch voice/,
    );
    const absent = { ...timeline, narrationSource: "absent" as const };
    expect(finalRenderProblems(ready({ timeline: absent })).join(" ")).toMatch(
      /no narration/,
    );
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

  it("blocks a programme without captions", () => {
    expect(finalRenderProblems(ready({ cueCount: 0 })).join(" ")).toMatch(
      /no captions/,
    );
  });
});
