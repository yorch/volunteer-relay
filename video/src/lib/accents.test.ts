import { describe, expect, it } from "vitest";
import { accentCues, accentKindFor } from "./accents.ts";

describe("accent mapping", () => {
  it("maps decision markers to confirms and navigation to clicks", () => {
    expect(accentKindFor("accepted")).toBe("confirm");
    expect(accentKindFor("acknowledged")).toBe("confirm");
    expect(accentKindFor("report-filtered")).toBe("confirm");
    expect(accentKindFor("duplicate-open")).toBe("click");
    expect(accentKindFor("hold-complete")).toBeNull();
    expect(accentKindFor("checkpoint:baseline")).toBeNull();
  });

  it("places cues on programme frames and de-duplicates per second", () => {
    const cues = accentCues(
      [
        {
          startFrame: 300,
          markers: [
            { label: "accepted", atSeconds: 1.2 },
            { label: "accepted", atSeconds: 1.4 },
            { label: "ledger-visible", atSeconds: 4 },
          ],
        },
      ],
      30,
    );
    expect(cues).toEqual([
      { atFrame: 336, kind: "confirm" },
      { atFrame: 420, kind: "click" },
    ]);
  });

  it("caps the number of cues so the edit stays quiet", () => {
    const cues = accentCues(
      [
        {
          startFrame: 0,
          markers: Array.from({ length: 30 }, (_, i) => ({
            label: "accepted",
            atSeconds: i * 2,
          })),
        },
      ],
      30,
      4,
    );
    expect(cues).toHaveLength(4);
  });
});
