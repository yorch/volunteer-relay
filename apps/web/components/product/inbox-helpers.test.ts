import { describe, expect, it } from "vitest";
import {
  authorName,
  buildSegments,
  countUnknown,
  deriveFlags,
  fieldDisplayLabel,
  relativeTime,
  resolveEvidenceRange,
} from "./inbox-helpers.ts";

const text = "Maya helped at the garden for 90 minutes on Saturday.";

describe("resolveEvidenceRange", () => {
  it("trusts offsets that still match the quote", () => {
    expect(
      resolveEvidenceRange(text, { start: 30, end: 40, quote: "90 minutes" }),
    ).toEqual({ start: 30, end: 40 });
  });
  it("falls back to the quote when offsets are wrong or out of range", () => {
    expect(
      resolveEvidenceRange(text, { start: 2, end: 5, quote: "90 minutes" }),
    ).toEqual({ start: 30, end: 40 });
    expect(
      resolveEvidenceRange(text, { start: 500, end: 600, quote: "garden" }),
    ).toEqual({ start: 19, end: 25 });
  });
  it("returns null when nothing can be located", () => {
    expect(
      resolveEvidenceRange(text, { start: 500, end: 600, quote: "absent" }),
    ).toBeNull();
    expect(resolveEvidenceRange(text, {})).toBeNull();
  });
});

describe("buildSegments", () => {
  it("returns one plain segment without ranges", () => {
    expect(buildSegments("abc", [])).toEqual([{ text: "abc", ids: [] }]);
  });
  it("marks a range and keeps the surrounding text", () => {
    expect(buildSegments("abcdef", [{ id: "a", start: 2, end: 4 }])).toEqual([
      { text: "ab", ids: [] },
      { text: "cd", ids: ["a"] },
      { text: "ef", ids: [] },
    ]);
  });
  it("shares the overlap between ranges and ignores invalid ones", () => {
    expect(
      buildSegments("abcdef", [
        { id: "a", start: 0, end: 4 },
        { id: "b", start: 2, end: 6 },
        { id: "bad", start: 4, end: 99 },
      ]),
    ).toEqual([
      { text: "ab", ids: ["a"] },
      { text: "cd", ids: ["a", "b"] },
      { text: "ef", ids: ["b"] },
    ]);
  });
});

describe("deriveFlags", () => {
  it("derives unknown, photo and urgent flags", () => {
    expect(
      deriveFlags({ attachments: [{}] }, [
        { kind: "contribution", durationMinutes: null },
        { kind: "activity", datePrecision: "unknown", localDate: null },
        { kind: "need", urgency: "urgent" },
      ]),
    ).toEqual(["unknownDuration", "unknownDate", "photo", "urgent"]);
  });
  it("is quiet for complete routine proposals", () => {
    expect(
      deriveFlags({ attachments: [] }, [
        { kind: "contribution", durationMinutes: 30 },
        { kind: "activity", datePrecision: "day", localDate: "2026-01-02" },
        { kind: "need", urgency: "routine" },
      ]),
    ).toEqual([]);
  });
  it("leads with duplicate when candidates exist", () => {
    expect(deriveFlags({}, [], 2)).toEqual(["duplicate"]);
  });
});

describe("countUnknown", () => {
  it("counts nulls and never evidence", () => {
    expect(
      countUnknown([
        { kind: "contribution", membershipId: null, durationMinutes: null },
        { kind: "activity", localDate: "2026-01-02" },
      ]),
    ).toBe(2);
  });
});

describe("authorName", () => {
  const members = [{ membershipId: "m1", name: "Maya Rivera" }];
  it("prefers the member name, else the external identity", () => {
    expect(
      authorName({ externalIdentity: "web:abc", membershipId: "m1" }, members),
    ).toBe("Maya Rivera");
    expect(
      authorName({ externalIdentity: "web:abc", membershipId: "zz" }, members),
    ).toBe("web:abc");
    expect(
      authorName({ externalIdentity: "tg:42", membershipId: null }, members),
    ).toBe("tg:42");
  });
  it("does not throw when a source has no author", () => {
    expect(authorName(undefined, members)).toBe("Unknown author");
    expect(authorName(null, members)).toBe("Unknown author");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-03-10T12:00:00Z");
  it("formats short spans", () => {
    expect(relativeTime("2026-03-10T11:59:40Z", now)).toBe("Just now");
    expect(relativeTime("2026-03-10T11:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-03-10T09:00:00Z", now)).toBe("3 hr ago");
    expect(relativeTime("2026-03-07T12:00:00Z", now)).toBe("3 d ago");
    expect(relativeTime("nope", now)).toBe("Unknown time");
  });
});

describe("fieldDisplayLabel", () => {
  it("uses human labels and falls back to sentence case", () => {
    expect(fieldDisplayLabel("membershipId")).toBe("Volunteer");
    expect(fieldDisplayLabel("durationMinutes")).toBe("Duration");
    expect(fieldDisplayLabel("someNewField")).toBe("Some new field");
  });
});
