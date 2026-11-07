import type { ExtractionProposal, SourceEnvelope } from "@relay/contracts";
import { findPatternSpan, findSpan, type TextSpan } from "./evidence.ts";
import type {
  ExtractionProvider,
  ExtractionProviderRequest,
  ProviderDraft,
} from "./provider.ts";

type ProposalItem = ExtractionProposal["items"][number];
type Evidence = ProposalItem["evidence"][number];
type Unresolved = ExtractionProposal["unresolved"][number];

export const DETERMINISTIC_MODEL_VERSION = "provider-free-rules-v1";
export const DETERMINISTIC_PROMPT_VERSION = "fixture-rules-v1";

/**
 * Bounded, deterministic rule adapter for tests and evaluations. It is not a
 * language model: it never calls a provider, never reads expected results and
 * never looks up a source ID. It parses the preserved text only, and returns a
 * draft that the service must still validate as untrusted input.
 */
export function createDeterministicProvider(): ExtractionProvider {
  return {
    name: "deterministic-fixture-rules",
    async extract(request: ExtractionProviderRequest) {
      return extractDraft(request.source);
    },
  };
}

const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|the\s+)?(?:previous\s+|earlier\s+)?(?:instructions?|polic(?:y|ies))\b/i,
  /\bdisregard\s+(?:all\s+|the\s+)?(?:previous\s+|earlier\s+)?(?:instructions?|polic(?:y|ies))\b/i,
  /\breveal\s+[^.!?]*\bsecrets?\b/i,
  /\bapprove\s+\d+\s+hours?\b/i,
  /\bsystem\s+prompt\b/i,
];

const NEED_CLAUSE =
  /(?:necesitamos|we need|may have no|no food|needs? (?:blankets|supplies|food))[^.!?]*[.!?]?/i;
const NEGATED_URGENCY =
  /\bno es urgente\b|\bnot urgent\b|\bno urgency\b|\broutine\b/i;
const URGENT_SIGNAL =
  /\burgent(?:ly|e)?\b|\burgentemente\b|\btonight\b|\bimmediately\b|\basap\b|\bmay have no\b/i;
const PROVISIONAL_SIGNAL = /\bmay\b|\bmight\b|\bpossibly\b|\bprobably\b/i;
const FOOD_CATEGORY =
  /\bcomida\b|\balimentos\b|\bfood\b|\bmeals?\b|\bgroceries\b/i;
const SUPPLIES_CATEGORY =
  /\bmantas\b|\bcobijas\b|\bblankets?\b|\bsupplies\b|\bsuministros\b|\bclothing\b/i;
const VISIT = /\bvisit(?:ed|s)?\b/i;
const SUPPLY_WORK = /\bsorted\b|\bpacked\b|\bassembled\b/i;
const CORRECTION = /\bcorrection\b|\bnot \d+\b/i;
const DURATION = /\b(\d{1,4})\s*(?:minutes?|mins?|min)\b/i;
const UNTRACKED_TIME =
  /\bdid not track\b|\bdon't know\b|\bunknown\b|\bno recuerdo\b/i;
const BENEFICIARY = /\b(?:household\s+)?([A-Z]-\d{2})\b/;
const EXPLICIT_DATE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i;
const TODAY = /\btoday\b|\bhoy\b/i;
const DUPLICATE_SIGNAL = /\brepeat(?:ing)?\b|\bearlier report\b|\bsame\b/i;
const ADDITIONAL_PARTICIPANT = /\b(?:and|with)\s+([A-Z][a-z]{2,})\b/;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function localDateOf(
  instant: string | null,
  timezone: string,
): LocalDate | null {
  if (instant === null) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const value = (type: string): string | undefined =>
      parts.find((part) => part.type === type)?.value;
    const year = Number(value("year"));
    const month = Number(value("month"));
    const day = Number(value("day"));
    if (![year, month, day].every(Number.isInteger)) return null;
    return { year, month, day };
  } catch {
    return null;
  }
}

function isRealDate({ year, month, day }: LocalDate): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isoDate(date: LocalDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

interface ResolvedDate {
  readonly localDate: string | null;
  readonly precision: "day" | "unknown";
  readonly span: TextSpan | null;
  readonly reason: string | null;
}

function resolveDate(text: string, source: SourceEnvelope): ResolvedDate {
  const local = localDateOf(
    source.occurredAt ?? source.receivedAt,
    source.timezone,
  );
  const explicit = findPatternSpan(text, EXPLICIT_DATE);
  if (explicit !== null && local !== null) {
    const match = EXPLICIT_DATE.exec(text);
    const monthName = match?.[1]?.toLowerCase();
    const dayText = match?.[2];
    const monthIndex =
      monthName === undefined
        ? -1
        : MONTH_NAMES.indexOf(monthName as (typeof MONTH_NAMES)[number]);
    const day = Number(dayText);
    if (monthIndex >= 0 && Number.isInteger(day)) {
      const candidate = { year: local.year, month: monthIndex + 1, day };
      if (isRealDate(candidate))
        return {
          localDate: isoDate(candidate),
          precision: "day",
          span: explicit,
          reason: null,
        };
    }
  }
  if (local !== null) {
    const today = findPatternSpan(text, TODAY);
    if (today !== null)
      return {
        localDate: isoDate(local),
        precision: "day",
        span: today,
        reason: null,
      };
  }
  return {
    localDate: null,
    precision: "unknown",
    span: null,
    reason:
      source.replyToSourceId === null
        ? "local_date_not_reported"
        : "local_date_requires_reply_context",
  };
}

function textEvidence(
  field: string,
  source: SourceEnvelope,
  span: TextSpan,
): Evidence {
  return {
    kind: "text",
    field,
    sourceId: source.sourceId,
    sourceRevision: source.revision,
    start: span.start,
    end: span.end,
    quote: span.quote,
  };
}

function draft(
  items: readonly ProposalItem[],
  unresolved: readonly Unresolved[],
): ProviderDraft {
  return { items, unresolved };
}

function durationOf(text: string): {
  minutes: number | null;
  span: TextSpan | null;
} {
  const span = findPatternSpan(text, DURATION);
  if (span === null) return { minutes: null, span: null };
  const digits = DURATION.exec(text)?.[1];
  const minutes = Number(digits);
  if (!Number.isInteger(minutes) || minutes <= 0)
    return { minutes: null, span };
  return { minutes, span };
}

function extractDraft(source: SourceEnvelope): ProviderDraft {
  const text = source.text;
  if (text.trim().length === 0) {
    // A photo alone never establishes identity, activity or duration.
    if (source.attachments.length > 0)
      return draft(
        [],
        [
          { field: "activity", reason: "attachment_only_source" },
          {
            field: "attachmentObservations",
            reason: "no_visual_model_in_provider_free_adapter",
          },
        ],
      );
    return draft([], [{ field: "activity", reason: "empty_source" }]);
  }

  // Source text is untrusted input. A quarantined message yields no candidate
  // facts at all; the preserved source stays available for staff review.
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text)))
    return draft(
      [],
      [{ field: "text", reason: "instruction_like_content_ignored" }],
    );

  const { minutes, span: durationSpan } = durationOf(text);
  const date = resolveDate(text, source);
  const dateEvidence: Evidence[] =
    date.span === null ? [] : [textEvidence("localDate", source, date.span)];
  const dateUnresolved: Unresolved[] =
    date.reason === null ? [] : [{ field: "localDate", reason: date.reason }];

  if (CORRECTION.test(text) && durationSpan !== null && minutes !== null) {
    const reasonSpan =
      findPatternSpan(text, /correction[^.!?]*[.!?]?/i) ?? durationSpan;
    return draft(
      [
        {
          kind: "correction",
          key: `${source.sourceId}-correction-1`,
          targetId: null,
          expectedRevision: null,
          durationMinutes: minutes,
          reason: reasonSpan.quote,
          evidence: [
            textEvidence("durationMinutes", source, durationSpan),
            textEvidence("reason", source, reasonSpan),
          ],
        },
      ],
      [
        {
          field: "targetId",
          reason: "correction_target_requires_reconciliation",
        },
      ],
    );
  }

  const needClause = findPatternSpan(text, NEED_CLAUSE);
  if (needClause !== null) {
    const category = FOOD_CATEGORY.test(text)
      ? "food"
      : SUPPLIES_CATEGORY.test(text)
        ? "supplies"
        : "general";
    const urgent =
      !NEGATED_URGENCY.test(text) &&
      (URGENT_SIGNAL.test(text) ||
        needClause.quote.toLowerCase().includes("urgent"));
    const provisional = urgent && PROVISIONAL_SIGNAL.test(text);
    const summary =
      needClause.quote.length > 200
        ? needClause.quote.slice(0, 200)
        : needClause.quote;
    return draft(
      [
        {
          kind: "need",
          key: `${source.sourceId}-need-1`,
          category,
          urgency: urgent ? "urgent" : "routine",
          summary,
          provisional,
          evidence: [
            textEvidence("category", source, needClause),
            textEvidence("urgency", source, needClause),
            textEvidence("summary", source, needClause),
          ],
        },
      ],
      provisional
        ? [
            {
              field: "needFacts",
              reason: "provisional_alert_requires_staff_confirmation",
            },
          ]
        : [],
    );
  }

  const visit = VISIT.test(text);
  const supplyWork = !visit && SUPPLY_WORK.test(text);
  if (visit || supplyWork) {
    const activityKind = visit ? "visit" : "supplies";
    const anchor =
      findPatternSpan(text, visit ? VISIT : SUPPLY_WORK) ?? durationSpan;
    if (anchor === null)
      return draft(
        [],
        [{ field: "activity", reason: "activity_not_recognised" }],
      );
    const beneficiarySpan = visit ? findPatternSpan(text, BENEFICIARY) : null;
    const beneficiaryReference = visit
      ? (BENEFICIARY.exec(text)?.[1] ?? null)
      : null;
    const activityKey = `${source.sourceId}-activity-1`;
    const membershipId = source.author.membershipId;
    const unresolved: Unresolved[] = [...dateUnresolved];
    if (membershipId === null)
      unresolved.push({
        field: "contributionMembership",
        reason: "author_identity_unresolved",
      });
    if (visit && ADDITIONAL_PARTICIPANT.test(text))
      unresolved.push({
        field: "additionalParticipants",
        reason: "participant_identity_requires_resolution",
      });
    if (DUPLICATE_SIGNAL.test(text))
      unresolved.push({
        field: "duplicateCandidate",
        reason: "candidate_link_requires_reconciliation",
      });

    const activityEvidence: Evidence[] = [
      textEvidence("activityKind", source, anchor),
      ...(beneficiarySpan === null
        ? []
        : [textEvidence("beneficiaryReference", source, beneficiarySpan)]),
      ...dateEvidence,
    ];
    const contributionEvidence: Evidence[] = [
      textEvidence("durationMinutes", source, durationSpan ?? anchor),
    ];
    if (minutes === null) {
      unresolved.push({
        field: "durationMinutes",
        reason: "duration_not_reported",
      });
      const untracked = findPatternSpan(text, UNTRACKED_TIME);
      if (untracked !== null)
        contributionEvidence.push(
          textEvidence("durationMinutes", source, untracked),
        );
    }

    return draft(
      [
        {
          kind: "activity",
          key: activityKey,
          activityKind,
          localDate: date.localDate,
          datePrecision: date.precision,
          beneficiaryReference,
          evidence: activityEvidence,
        },
        {
          kind: "contribution",
          key: `${source.sourceId}-contribution-1`,
          activityKey,
          membershipId,
          durationMinutes: minutes,
          evidence: contributionEvidence,
        },
      ],
      unresolved,
    );
  }

  return draft([], [{ field: "activity", reason: "activity_not_recognised" }]);
}

/** Convenience for tests/evals: locate an exact substring span or throw. */
export function requireSpan(text: string, needle: string): TextSpan {
  const span = findSpan(text, needle);
  if (span === null) throw new Error("Expected substring is not present");
  return span;
}
