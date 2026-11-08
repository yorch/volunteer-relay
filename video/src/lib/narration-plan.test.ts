import { describe, expect, it } from "vitest";
import { scenesToGenerate } from "./narration-plan.ts";
import type { Scene } from "./schema.ts";

const scene = (id: string) =>
  ({
    id,
    title: id,
    kind: "graphic",
    narration: "x",
    onScreenDisclosure: null,
    capture: null,
    overlays: [],
    focus: [],
    minSeconds: 10,
    maxSeconds: 20,
  }) satisfies Scene;

describe("narration generation plan", () => {
  const selected = [scene("S01"), scene("S02"), scene("S03")];

  it("requests only cache misses by default", () => {
    expect(
      scenesToGenerate({
        selected,
        cacheHits: [selected[0] as Scene, selected[2] as Scene],
        force: false,
      }).map((entry) => entry.id),
    ).toEqual(["S02"]);
  });

  it("requests nothing when every scene is cached", () => {
    expect(
      scenesToGenerate({ selected, cacheHits: selected, force: false }),
    ).toEqual([]);
  });

  it("requests everything when forced", () => {
    expect(
      scenesToGenerate({ selected, cacheHits: selected, force: true }),
    ).toHaveLength(3);
  });
});
