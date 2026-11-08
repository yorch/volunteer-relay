import { z } from "zod";
import type { LedgerSummary } from "./index.ts";
export const reportQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    program: z.string().min(1).max(100).optional(),
    membershipId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (query) => !query.from || !query.to || query.from <= query.to,
    "Invalid date range",
  );
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** Inclusive Monday–Sunday local dates in the organization timezone. */
export const reportWeekRangeSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .strict()
  .refine((range) => range.from <= range.to, "Invalid week range");
export type ReportWeekRange = z.infer<typeof reportWeekRangeSchema>;

/**
 * One volunteer's share of the approved ledger. Staff-only: it is never
 * returned to an aggregate-only (report:read without review:write) caller.
 */
export const reportContributorSchema = z
  .object({
    membershipId: z.string().min(1),
    approvedMinutes: z.number().int().nonnegative(),
    approvedContributions: z.number().int().positive(),
  })
  .strict();
export type ReportContributor = z.infer<typeof reportContributorSchema>;
export const REPORT_TOP_CONTRIBUTORS_LIMIT = 5;

/**
 * Additive dashboard fields. Every field is optional on the wire so older
 * servers and aggregate-only callers stay valid; clients must treat absence
 * as "not provided", never as zero.
 */
export const reportDashboardSchema = z
  .object({
    /** Current local week; null when the organization timezone is invalid. */
    weekRange: reportWeekRangeSchema.nullable().optional(),
    /** Approved minutes dated inside weekRange; null when weekRange is null. */
    weekApprovedMinutes: z.number().int().nonnegative().nullable().optional(),
    weekHours: z.number().nonnegative().nullable().optional(),
    /** Open needs (not resolved/cancelled) without an owner. */
    unassignedOpenNeeds: z.number().int().nonnegative().optional(),
    /** Staff-only; omitted for aggregate-only readers. */
    topContributors: z
      .array(reportContributorSchema)
      .max(REPORT_TOP_CONTRIBUTORS_LIMIT)
      .optional(),
    /** Staff-only: when the oldest current review entered the queue. */
    oldestQueuedReviewAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional(),
  })
  .strict();
export type ReportDashboard = z.infer<typeof reportDashboardSchema>;

export interface ProductReport {
  query: ReportQuery;
  timezone: string;
  ledger: LedgerSummary;
  approvedHours: number;
  openNeeds: number;
  resolvedNeeds: number;
  averageAcknowledgmentMinutes: number | null;
  averageResolutionMinutes?: number | null;
  excludedUnknownDate: number;
  weekRange?: ReportWeekRange | null;
  weekApprovedMinutes?: number | null;
  weekHours?: number | null;
  unassignedOpenNeeds?: number;
  topContributors?: ReportContributor[];
  oldestQueuedReviewAt?: string | null;
}

const dayMs = 86_400_000;
const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/**
 * The Monday–Sunday week containing `now` as seen in `timezone`. Returns null
 * for an invalid instant or timezone instead of guessing UTC.
 */
export function reportWeekRange(
  timezone: string,
  now: Date,
): ReportWeekRange | null {
  if (Number.isNaN(now.getTime()) || !timezone) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const part = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const year = part("year"),
    month = part("month"),
    day = part("day");
  if (![year, month, day].every(Number.isInteger)) return null;
  const local = Date.UTC(year, month - 1, day);
  const sinceMonday = (new Date(local).getUTCDay() + 6) % 7;
  const monday = local - sinceMonday * dayMs;
  return {
    from: isoDay(new Date(monday)),
    to: isoDay(new Date(monday + 6 * dayMs)),
  };
}
