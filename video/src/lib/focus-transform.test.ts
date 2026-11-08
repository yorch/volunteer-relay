import { describe, expect, it } from "vitest";
import {
  focusCss,
  focusOrigin,
  focusTransform,
  MAX_FOCUS_SCALE,
} from "./focus-transform.ts";
import type { Focus } from "./schema.ts";

const target: Focus = {
  x: 0.3,
  y: 0.4,
  scale: 1.06,
  atSeconds: 2,
  holdSeconds: 6,
};

describe("focus transform", () => {
  it("is identity outside a focus window", () => {
    expect(focusTransform(0, [target])).toEqual({
      scale: 1,
      originX: 0.5,
      originY: 0.5,
    });
    expect(focusTransform(9, [target]).scale).toBe(1);
  });

  it("ramps in instead of snapping", () => {
    expect(focusTransform(2.05, [target]).scale).toBeLessThan(
      focusTransform(4, [target]).scale,
    );
  });

  it("anchors the zoom on the focus point and never translates", () => {
    const held = focusTransform(4, [target]);
    expect(held.originX).toBeCloseTo(0.3, 6);
    expect(held.originY).toBeCloseTo(0.4, 6);
    expect(focusCss(held)).toBe("scale(1.06)");
    expect(focusCss(held)).not.toContain("translate");
    expect(focusOrigin(held)).toBe("30% 40%");
  });

  it("caps extreme scales", () => {
    expect(focusTransform(4, [{ ...target, scale: 3 }]).scale).toBeCloseTo(
      MAX_FOCUS_SCALE,
      6,
    );
  });
});
