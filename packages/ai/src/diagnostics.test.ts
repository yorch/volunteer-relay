import { describe, expect, it } from "vitest";
import { boundedFailureDetail } from "./diagnostics.ts";

describe("boundedFailureDetail", () => {
  it("returns undefined when there is nothing to report", () => {
    expect(boundedFailureDetail(undefined)).toBeUndefined();
    expect(boundedFailureDetail({})).toBeUndefined();
  });

  // This is the shape the extraction service emits for an evidence mismatch:
  // positions on the left, machine codes on the right.
  it("keeps the position/code pairs that make a validation failure diagnosable", () => {
    expect(
      boundedFailureDetail({
        "items[0].evidence[1]": ["quote_mismatch"],
        "items[1].evidence[0]": ["out_of_range", "unknown_source"],
      }),
    ).toEqual({
      "items[0].evidence[1]": ["quote_mismatch"],
      "items[1].evidence[0]": ["out_of_range", "unknown_source"],
    });
  });

  it("caps the number of fields and values so a log line stays bounded", () => {
    const many = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `items[${index}].evidence[0]`,
        Array.from({ length: 10 }, (_, value) => `code_${value}`),
      ]),
    );
    const bounded = boundedFailureDetail(many);
    if (!bounded) throw new Error("expected detail");
    expect(Object.keys(bounded)).toHaveLength(8);
    expect(Object.values(bounded)[0]).toHaveLength(4);
  });

  it("truncates long keys and values instead of passing free-form text through", () => {
    const long = "x".repeat(500);
    const bounded = boundedFailureDetail({ [long]: [long] });
    if (!bounded) throw new Error("expected detail");
    const first = Object.entries(bounded)[0];
    if (!first) throw new Error("expected one field");
    const [key, values] = first;
    expect(key.length).toBeLessThanOrEqual(96);
    expect(values[0]?.length).toBeLessThanOrEqual(96);
  });

  // A `__proto__` key must land as an ordinary entry rather than vanishing
  // into the prototype chain. Built with JSON.parse so it is a real own
  // property: an object literal's `__proto__:` sets the prototype instead.
  it("keeps a __proto__ key as data", () => {
    const input = JSON.parse(
      '{"__proto__":["prototype_pollution"],"items[0].evidence[0]":["quote_not_in_source_revision"]}',
    ) as Record<string, string[]>;
    const bounded = boundedFailureDetail(input);
    if (!bounded) throw new Error("expected detail");
    expect(Object.getPrototypeOf(bounded)).toBeNull();
    expect(Object.keys(bounded)).toContain("__proto__");
    expect(bounded["__proto__"]).toEqual(["prototype_pollution"]);
  });

  // Truncated keys can collide; the values must merge rather than overwrite, so
  // no position is silently dropped.
  it("merges values when truncated keys collide", () => {
    const prefix = "k".repeat(96);
    const bounded = boundedFailureDetail({
      [`${prefix}a`]: ["first"],
      [`${prefix}b`]: ["second"],
    });
    if (!bounded) throw new Error("expected detail");
    expect(Object.keys(bounded)).toHaveLength(1);
    expect(Object.values(bounded)[0]).toEqual(["first", "second"]);
  });
});
