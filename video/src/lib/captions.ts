import { z } from "zod";

/**
 * Caption derivation. Captions come from provider alignment (word/character
 * timings) or a verified forced alignment step. When only supplied audio exists
 * the fallback distributes *phrases* proportionally inside the measured audio
 * duration and labels the result; per-word equal division is never used.
 */

export const cueSchema = z
  .object({
    startSeconds: z.number().finite().nonnegative(),
    endSeconds: z.number().finite().positive(),
    text: z.string().min(1),
  })
  .strict();

export type Cue = z.infer<typeof cueSchema>;

export interface WordTiming {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface CueOptions {
  maxCharsPerCue?: number;
  maxWordsPerCue?: number;
  maxCharsPerLine?: number;
  maxLines?: number;
  maxCueSeconds?: number;
}

const DEFAULTS = {
  maxCharsPerCue: 44,
  maxWordsPerCue: 10,
  maxCharsPerLine: 42,
  maxLines: 2,
  maxCueSeconds: 6,
} satisfies Required<CueOptions>;

export function normalizeSpeech(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,;:])(?=\S)/g, "$1 ")
    .trim();
}

export function splitSentences(text: string): string[] {
  return normalizeSpeech(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Group narration into phrase-level captions. A cue never crosses a sentence
 * boundary and stays inside the character/word budget.
 */
export function phraseGroups(text: string, options: CueOptions = {}): string[] {
  const { maxCharsPerCue, maxWordsPerCue } = { ...DEFAULTS, ...options };
  const groups: string[] = [];
  for (const sentence of splitSentences(text)) {
    const words = sentence.split(" ");
    let current: string[] = [];
    const flush = () => {
      if (current.length) groups.push(current.join(" "));
      current = [];
    };
    for (const word of words) {
      const candidate = [...current, word].join(" ");
      const tooLong =
        candidate.length > maxCharsPerCue ||
        current.length + 1 > maxWordsPerCue;
      if (tooLong && current.length) {
        flush();
        current = [word];
      } else current.push(word);
    }
    flush();
  }
  return groups;
}

/**
 * Character alignment from the provider (`characters`, start and end times) is
 * turned into word timings, then grouped. Character offsets are the only
 * alignment the adapter accepts; scene-level averaging is rejected.
 */
export function wordsFromCharacterAlignment(input: {
  characters: readonly string[];
  startSeconds: readonly number[];
  endSeconds: readonly number[];
}): WordTiming[] {
  const { characters, startSeconds, endSeconds } = input;
  if (
    characters.length !== startSeconds.length ||
    characters.length !== endSeconds.length
  )
    throw new Error("Alignment arrays must have equal length");
  const words: WordTiming[] = [];
  let buffer = "";
  let start = Number.NaN;
  let end = Number.NaN;
  const push = () => {
    const text = buffer.trim();
    if (text && Number.isFinite(start) && Number.isFinite(end))
      words.push({ text, startSeconds: start, endSeconds: end });
    buffer = "";
    start = Number.NaN;
    end = Number.NaN;
  };
  for (const [index, character] of characters.entries()) {
    const startAt = startSeconds[index];
    const endAt = endSeconds[index];
    if (startAt === undefined || endAt === undefined)
      throw new Error("Alignment arrays are sparse");
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt))
      throw new Error("Alignment timestamps must be finite");
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (!buffer) start = startAt;
    buffer += character;
    end = endAt;
  }
  push();
  return words;
}

export function captionsFromWords(
  words: readonly WordTiming[],
  offsetSeconds = 0,
  options: CueOptions = {},
): Cue[] {
  if (words.length === 0) return [];
  const { maxCharsPerCue, maxWordsPerCue, maxCueSeconds } = {
    ...DEFAULTS,
    ...options,
  };
  const cues: Cue[] = [];
  let current: WordTiming[] = [];
  const flush = () => {
    const first = current[0];
    const last = current.at(-1);
    if (!first || !last) return;
    cues.push({
      startSeconds: first.startSeconds + offsetSeconds,
      endSeconds: last.endSeconds + offsetSeconds,
      text: current.map((word) => word.text).join(" "),
    });
    current = [];
  };
  for (const word of words) {
    const candidate = [...current, word];
    const text = candidate.map((entry) => entry.text).join(" ");
    const first = candidate[0];
    const span =
      first === undefined || !current.length
        ? 0
        : word.endSeconds - first.startSeconds;
    if (
      current.length &&
      (text.length > maxCharsPerCue ||
        candidate.length > maxWordsPerCue ||
        span > maxCueSeconds ||
        /[.!?]$/.test(current.at(-1)?.text ?? ""))
    )
      flush();
    current.push(word);
  }
  flush();
  return cues;
}

/**
 * Fallback for supplied audio where no alignment exists. Phrase spans are
 * spread by phrase length across the measured duration. Callers must record
 * that this is derived, not aligned.
 */
export function captionsFromProportionalPhrases(
  text: string,
  audioDurationSeconds: number,
  offsetSeconds = 0,
  options: CueOptions = {},
): Cue[] {
  if (!(audioDurationSeconds > 0) || !Number.isFinite(audioDurationSeconds))
    throw new Error("Proportional captions need a measured audio duration");
  const groups = phraseGroups(text, options);
  const totalChars = groups.reduce((sum, group) => sum + group.length, 0);
  if (totalChars === 0) return [];
  let cursor = 0;
  return groups.map((group) => {
    const start = cursor;
    cursor = Math.min(
      audioDurationSeconds,
      cursor + (group.length / totalChars) * audioDurationSeconds,
    );
    return {
      startSeconds: offsetSeconds + start,
      endSeconds: offsetSeconds + cursor,
      text: group,
    };
  });
}

export function wrapCue(
  text: string,
  maxCharsPerLine = DEFAULTS.maxCharsPerLine,
): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else current = candidate;
  }
  if (current) lines.push(current);
  return lines;
}

export function validateCues(
  cues: readonly Cue[],
  mediaDurationSeconds: number,
  options: CueOptions = {},
): string[] {
  const { maxLines, maxCharsPerLine, maxCueSeconds } = {
    ...DEFAULTS,
    ...options,
  };
  const problems: string[] = [];
  let previousEnd = -1;
  for (const [index, cue] of cues.entries()) {
    const label = `cue ${index + 1} (${JSON.stringify(cue.text)})`;
    if (!Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds))
      problems.push(`${label}: timestamps must be finite`);
    if (cue.endSeconds <= cue.startSeconds)
      problems.push(`${label}: ends before it starts`);
    if (cue.startSeconds < previousEnd - 1e-6)
      problems.push(`${label}: overlaps the previous cue`);
    if (cue.endSeconds > mediaDurationSeconds + 1e-6)
      problems.push(`${label}: runs past the media duration`);
    if (cue.endSeconds - cue.startSeconds > maxCueSeconds + 1e-6)
      problems.push(`${label}: longer than ${maxCueSeconds}s`);
    if (wrapCue(cue.text, maxCharsPerLine).length > maxLines)
      problems.push(`${label}: needs more than ${maxLines} lines`);
    previousEnd = cue.endSeconds;
  }
  return problems;
}

function srtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

export function toSrt(cues: readonly Cue[]): string {
  return `${cues
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTimestamp(cue.startSeconds)} --> ${srtTimestamp(
          cue.endSeconds,
        )}\n${wrapCue(cue.text).join("\n")}\n`,
    )
    .join("\n")
    .trimEnd()}\n`;
}
