import { describe, expect, it } from "vitest";
import {
  captionsFromProportionalPhrases,
  captionsFromWords,
  phraseGroups,
  toSrt,
  validateCues,
  wordsFromCharacterAlignment,
  wrapCue,
} from "./captions.ts";

const NARRATION =
  "One message holds a visit for two people. One shared hour means one visit and two volunteer-hours.";

function alignmentFromText(text: string, perCharacter = 0.06) {
  const characters = [...text];
  const start = characters.map((_, index) => index * perCharacter);
  const end = characters.map((_, index) => (index + 1) * perCharacter);
  return { characters, startSeconds: start, endSeconds: end };
}

describe("phrase grouping", () => {
  it("keeps every sentence in at least one phrase", () => {
    const groups = phraseGroups(NARRATION);
    expect(groups.join(" ")).toBe(NARRATION);
    expect(
      groups.every((group) => !/[.!?]$/.test(group) || group.length > 1),
    ).toBe(true);
  });

  it("respects the character and word budget", () => {
    const groups = phraseGroups(NARRATION, {
      maxCharsPerCue: 30,
      maxWordsPerCue: 6,
    });
    for (const group of groups) {
      expect(group.length).toBeLessThanOrEqual(30);
      expect(group.split(" ").length).toBeLessThanOrEqual(6);
    }
  });

  it("wraps a cue to bounded lines", () => {
    expect(wrapCue("Short cue", 42)).toHaveLength(1);
    expect(
      wrapCue("One shared hour means one visit and two volunteer-hours.", 42),
    ).toHaveLength(2);
    expect(wrapCue(NARRATION, 42).length).toBeGreaterThan(2);
  });
});

describe("alignment captions", () => {
  const alignment = alignmentFromText(
    "One shared hour means one visit and two volunteer-hours.",
  );

  it("turns character alignment into word timings", () => {
    const words = wordsFromCharacterAlignment(alignment);
    expect(words.map((word) => word.text)).toEqual([
      "One",
      "shared",
      "hour",
      "means",
      "one",
      "visit",
      "and",
      "two",
      "volunteer-hours.",
    ]);
    expect(words[0]?.startSeconds).toBe(0);
    expect(words.at(-1)?.endSeconds).toBeGreaterThan(0);
  });

  it("rejects inconsistent alignment arrays", () => {
    expect(() =>
      wordsFromCharacterAlignment({
        characters: ["a", "b"],
        startSeconds: [0],
        endSeconds: [0.1, 0.2],
      }),
    ).toThrow(/equal length/);
    expect(() =>
      wordsFromCharacterAlignment({
        characters: ["a", "b"],
        startSeconds: [0, Number.NaN],
        endSeconds: [0.1, 0.2],
      }),
    ).toThrow(/finite/);
  });

  it("groups words into cues without crossing sentence ends", () => {
    const words = wordsFromCharacterAlignment(alignment);
    const cues = captionsFromWords(words, 5);
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) {
      expect(cue.startSeconds).toBeGreaterThanOrEqual(5);
      expect(cue.endSeconds).toBeGreaterThan(cue.startSeconds);
    }
    const end = alignment.endSeconds.at(-1) ?? 0;
    expect(validateCues(cues, 5 + end)).toEqual([]);
  });
});

describe("proportional fallback", () => {
  it("distributes phrases across the measured duration, not per word", () => {
    const cues = captionsFromProportionalPhrases(NARRATION, 8.2, 12);
    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]?.startSeconds).toBe(12);
    expect(cues.at(-1)?.endSeconds).toBeCloseTo(20.2, 5);
    const spans = cues.map((cue) => cue.endSeconds - cue.startSeconds);
    expect(new Set(spans.map((span) => span.toFixed(4))).size).toBeGreaterThan(
      1,
    );
  });

  it("refuses to invent timings without a measured duration", () => {
    expect(() => captionsFromProportionalPhrases(NARRATION, 0)).toThrow(
      /measured audio duration/,
    );
  });
});

describe("cue validation", () => {
  it("flags overlaps, overruns and three-line cues", () => {
    const problems = validateCues(
      [
        { startSeconds: 0, endSeconds: 2, text: "first cue" },
        {
          startSeconds: 1.5,
          endSeconds: 12,
          text: "overlapping cue that runs long",
        },
        {
          startSeconds: 12,
          endSeconds: 13,
          text: "a deliberately long caption line that keeps going and going and needs at least three wrapped lines to fit",
        },
      ],
      10,
    );
    expect(problems.some((problem) => problem.includes("overlaps"))).toBe(true);
    expect(problems.some((problem) => problem.includes("past the media"))).toBe(
      true,
    );
    expect(problems.some((problem) => problem.includes("longer than"))).toBe(
      true,
    );
    expect(
      problems.some((problem) => problem.includes("more than 2 lines")),
    ).toBe(true);
  });

  it("writes SRT with millisecond timestamps", () => {
    const srt = toSrt([
      { startSeconds: 0, endSeconds: 1.5, text: "Hello there." },
      { startSeconds: 61.25, endSeconds: 63, text: "Second cue." },
    ]);
    expect(srt).toContain("00:00:00,000 --> 00:00:01,500");
    expect(srt).toContain("00:01:01,250 --> 00:01:03,000");
    expect(srt.trim().split(/\n\n/)).toHaveLength(2);
  });
});
