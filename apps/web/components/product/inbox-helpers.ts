/** Pure helpers for the source inbox review screen. No React, no DOM. */

export interface TextRange {
  id: string;
  start: number;
  end: number;
}

export interface Segment {
  text: string;
  /** Ids of every evidence range that covers this segment (empty = plain). */
  ids: string[];
}

/**
 * Resolve the span of a quoted evidence line inside the source text. Offsets
 * are trusted only when they are in range and the slice still equals the
 * quote; otherwise fall back to the first occurrence of the quote, then null.
 */
export function resolveEvidenceRange(
  text: string,
  evidence: { start?: number; end?: number; quote?: string },
): { start: number; end: number } | null {
  const { start, end, quote } = evidence;
  if (
    typeof start === "number" &&
    typeof end === "number" &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length &&
    (quote === undefined || text.slice(start, end) === quote)
  )
    return { start, end };
  if (quote) {
    const found = text.indexOf(quote);
    if (found >= 0) return { start: found, end: found + quote.length };
  }
  return null;
}

/** Split text at every range boundary; overlapping ranges share a segment. */
export function buildSegments(text: string, ranges: TextRange[]): Segment[] {
  const valid = ranges.filter(
    (r) => r.start >= 0 && r.end > r.start && r.end <= text.length,
  );
  const cuts = [
    ...new Set([0, text.length, ...valid.flatMap((r) => [r.start, r.end])]),
  ]
    .filter((n) => n >= 0 && n <= text.length)
    .sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i] as number;
    const to = cuts[i + 1] as number;
    if (to <= from) continue;
    segments.push({
      text: text.slice(from, to),
      ids: valid.filter((r) => r.start <= from && r.end >= to).map((r) => r.id),
    });
  }
  return segments;
}

export interface FlagSource {
  attachments?: unknown[] | undefined;
}
export interface FlagItem {
  kind: string;
  durationMinutes?: number | null | undefined;
  datePrecision?: string | undefined;
  localDate?: string | null | undefined;
  urgency?: string | undefined;
}
export type InboxFlag =
  | "duplicate"
  | "unknownDuration"
  | "unknownDate"
  | "photo"
  | "urgent";

export const flagLabels: Record<InboxFlag, string> = {
  duplicate: "Duplicate candidate",
  unknownDuration: "Unknown duration",
  unknownDate: "Unknown date",
  photo: "Photo",
  urgent: "Urgent need",
};

/** Small review flags derived only from data the snapshot already carries. */
export function deriveFlags(
  source: FlagSource,
  items: FlagItem[],
  duplicateCandidates = 0,
): InboxFlag[] {
  const flags: InboxFlag[] = [];
  if (duplicateCandidates > 0) flags.push("duplicate");
  if (
    items.some(
      (i) =>
        (i.kind === "contribution" || i.kind === "correction") &&
        i.durationMinutes === null,
    )
  )
    flags.push("unknownDuration");
  if (
    items.some(
      (i) =>
        i.kind === "activity" &&
        (i.datePrecision === "unknown" || i.localDate === null),
    )
  )
    flags.push("unknownDate");
  if ((source.attachments?.length ?? 0) > 0) flags.push("photo");
  if (items.some((i) => i.kind === "need" && i.urgency === "urgent"))
    flags.push("urgent");
  return flags;
}

/** Count proposed values that are unknown (null), never treating them as 0. */
export function countUnknown(items: object[]): number {
  let count = 0;
  for (const item of items)
    for (const [name, value] of Object.entries(item))
      if (value === null && name !== "evidence") count++;
  return count;
}

/** Member display name when the snapshot knows the membership. */
export function authorName(
  author:
    | { externalIdentity: string; membershipId: string | null }
    | null
    | undefined,
  members: Array<{ membershipId: string; name: string }>,
): string {
  if (!author) return "Unknown author";
  const member = author.membershipId
    ? members.find((m) => m.membershipId === author.membershipId)
    : undefined;
  return member?.name ?? author.externalIdentity;
}

/** Compact relative time ("5 min ago", "3 d ago"); falls back to a date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Unknown time";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 0) return "Just now";
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(then).toLocaleDateString();
}

const labelOverrides: Record<string, string> = {
  membershipId: "Volunteer",
  durationMinutes: "Duration",
  activityKey: "Activity",
  activityKind: "Activity type",
  localDate: "Date",
  datePrecision: "Date precision",
  beneficiaryReference: "Beneficiary",
  targetId: "Target",
  expectedRevision: "Target revision",
  provisional: "Provisional",
};

/** Human label for a proposal field name (camelCase falls back to words). */
export function fieldDisplayLabel(name: string): string {
  const override = labelOverrides[name];
  if (override) return override;
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.replace(/^./, (letter) => letter.toUpperCase());
}
