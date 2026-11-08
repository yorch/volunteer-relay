import { describe, expect, it } from "vitest";
import {
  focusCss,
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
    expect(focusTransform(0, [target])).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(focusTransform(9, [target])).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("ramps in instead of snapping", () => {
    const start = focusTransform(2.05, [target]);
    const held = focusTransform(4, [target]);
    expect(start.scale).toBeLessThan(held.scale);
    expect(held.tx).toBeCloseTo(0.2, 6);
  });

  it("covers the viewport after translating", () => {
    const held = focusTransform(4, [target]);
    expect(held.scale).toBeGreaterThanOrEqual(1 + Math.abs(held.tx) - 1e-9);
    expect(held.scale).toBeGreaterThanOrEqual(1 + Math.abs(held.ty) - 1e-9);
    expect(held.scale).toBeLessThanOrEqual(MAX_FOCUS_SCALE);
  });

  it("caps extreme corner pushes", () => {
    const corner = focusTransform(4, [{ ...target, x: 0, y: 0 }]);
    expect(corner.scale).toBeLessThanOrEqual(MAX_FOCUS_SCALE);
    expect(corner.tx).toBeCloseTo(0.5, 6);
    expect(focusCss(corner)).toContain("translate(");
  });

  it("returns a CSS transform string", () => {
    expect(focusCss({ scale: 1.1, tx: -0.05, ty: 0 })).toBe(
      "translate(-5%, 0%) scale(1.1)",
    );
  });
});
