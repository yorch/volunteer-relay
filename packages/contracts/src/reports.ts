import { z } from "zod";
import type { LedgerSummary } from "./index.ts";
export const reportViewSchema = z.enum(["summary", "volunteers"]);
export type ReportView = z.infer<typeof reportViewSchema>;
export const reportQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    program: z.string().min(1).max(100).optional(),
    membershipId: z.string().min(1).optional(),
    /**
     * `reports.csv` only: "summary" (the default when absent) is the one-row
     * aggregate export; "volunteers" is the staff-only per-volunteer export.
     * `GET reports` accepts and ignores it.
     */
    view: reportViewSchema.optional(),
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
 * One row of the staff-only volunteer hours roster: every member with at
 * least one approved or pending contribution under the report filters.
 * Pending counts are contributions, never minutes: pending time is not
 * approved time. `weekApprovedMinutes` uses the report's local week (it
 * ignores from/to) and is null exactly when the report week is unknown.
 */
export const reportVolunteerSchema = z
  .object({
    membershipId: z.string().min(1),
    approvedMinutes: z.number().int().nonnegative(),
    weekApprovedMinutes: z.number().int().nonnegative().nullable(),
    approvedContributions: z.number().int().nonnegative(),
    pendingContributions: z.number().int().nonnegative(),
    pendingUnknownDuration: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (row) => row.approvedContributions + row.pendingContributions > 0,
    "A roster row needs at least one contribution in scope",
  )
  .refine(
    (row) => row.pendingUnknownDuration <= row.pendingContributions,
    "Unknown-duration pending contributions are a subset of pending",
  );
export type ReportVolunteer = z.infer<typeof reportVolunteerSchema>;
/** Safe upper bound on roster rows; `volunteersTruncated` flags the cut. */
export const REPORT_VOLUNTEERS_LIMIT = 500;

/** Weeks in the per-volunteer trend, ending with the current local week. */
export const REPORT_DETAIL_WEEKS = 8;
/** Upper bound on per-volunteer activity rows; the flag marks the cut. */
export const REPORT_DETAIL_ACTIVITIES_LIMIT = 20;

/** One Monday–Sunday local week; no approved time is a known 0. */
export const reportDetailWeekSchema = z
  .object({
    weekStart: z.iso.date(),
    approvedMinutes: z.number().int().nonnegative(),
  })
  .strict();
export type ReportDetailWeek = z.infer<typeof reportDetailWeekSchema>;

/**
 * One activity's share of a volunteer's approved time. Activities carry a
 * kind (the report "program") and a local date, not a free-text name; the
 * date is null when unknown.
 */
export const reportDetailActivitySchema = z
  .object({
    activityId: z.string().min(1),
    kind: z.string(),
    localDate: z.iso.date().nullable(),
    approvedMinutes: z.number().int().nonnegative(),
    approvedContributions: z.number().int().positive(),
  })
  .strict();
export type ReportDetailActivity = z.infer<typeof reportDetailActivitySchema>;

/**
 * Staff-only detail for the report's volunteer filter. `weeks` is the last
 * REPORT_DETAIL_WEEKS local weeks, oldest first, ending with `weekRange`; it
 * ignores from/to but keeps the program filter, and is null when the week is
 * unknown. Approved contributions on unknown-date activities never land in a
 * week; `unknownDateContributions` counts them (same program filter, no
 * from/to). `byActivity` uses every report filter and is ordered by approved
 * minutes descending, then activity id.
 */
export const reportVolunteerDetailSchema = z
  .object({
    membershipId: z.string().min(1),
    weeks: z
      .array(reportDetailWeekSchema)
      .length(REPORT_DETAIL_WEEKS)
      .nullable(),
    unknownDateContributions: z.number().int().nonnegative(),
    byActivity: z
      .array(reportDetailActivitySchema)
      .max(REPORT_DETAIL_ACTIVITIES_LIMIT),
    byActivityTruncated: z.boolean(),
  })
  .strict()
  .refine(
    (detail) =>
      !detail.weeks ||
      detail.weeks.every(
        (week, i, all) =>
          i === 0 ||
          Date.parse(week.weekStart) -
            Date.parse(all[i - 1]?.weekStart ?? "") ===
            7 * 86_400_000,
      ),
    "Weeks are consecutive, oldest first",
  );
export type ReportVolunteerDetail = z.infer<typeof reportVolunteerDetailSchema>;

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
    /**
     * Staff-only volunteer hours roster, ordered by approved minutes
     * descending then membership id; omitted for aggregate-only readers.
     */
    volunteers: z
      .array(reportVolunteerSchema)
      .max(REPORT_VOLUNTEERS_LIMIT)
      .optional(),
    /** Staff-only; true when more members than the limit were in scope. */
    volunteersTruncated: z.boolean().optional(),
    /** Staff-only; present only when the query has a volunteer filter. */
    volunteerDetail: reportVolunteerDetailSchema.optional(),
  })
  .strict()
  .refine(
    (dashboard) =>
      (dashboard.volunteers === undefined) ===
      (dashboard.volunteersTruncated === undefined),
    "volunteers and volunteersTruncated are provided together",
  );
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
  volunteers?: ReportVolunteer[];
  volunteersTruncated?: boolean;
  volunteerDetail?: ReportVolunteerDetail;
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

/**
 * The Monday dates of the `count` local weeks ending with `weekRange`, oldest
 * first. Pure calendar arithmetic on local dates, so no timezone is involved.
 */
export function reportDetailWeekStarts(
  weekRange: ReportWeekRange,
  count = REPORT_DETAIL_WEEKS,
): string[] {
  const last = Date.parse(`${weekRange.from}T00:00:00Z`);
  if (Number.isNaN(last)) return [];
  return Array.from({ length: Math.max(0, count) }, (_, i) =>
    isoDay(new Date(last - (count - 1 - i) * 7 * dayMs)),
  );
}
