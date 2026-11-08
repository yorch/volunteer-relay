import {
  type ProductReport,
  REPORT_TOP_CONTRIBUTORS_LIMIT,
  REPORT_VOLUNTEERS_LIMIT,
  type ReportContributor,
  type ReportQuery,
  type ReportVolunteer,
  type ReportWeekRange,
} from "@relay/contracts";

/** A raw SQL row; every field is coerced and checked here. */
export type ReportRow = Record<string, unknown>;

/**
 * Quotes one CSV cell and neutralizes spreadsheet formulas: a value starting
 * with =, +, -, @, tab or carriage return is prefixed with an apostrophe.
 * Unknown (null/undefined) becomes an empty cell, never zero.
 */
export function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const text = /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replaceAll('"', '""')}"`;
}

const count = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};
const nullableNumber = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const instant = (value: unknown) => {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

/** Ranks staff-visible contributors by approved minutes, then count, then id. */
export function topContributors(
  rows: readonly ReportRow[],
  limit = REPORT_TOP_CONTRIBUTORS_LIMIT,
): ReportContributor[] {
  return rows
    .flatMap((row) => {
      const membershipId = row.membership_id;
      const approvedContributions = count(row.approved);
      if (typeof membershipId !== "string" || !membershipId) return [];
      if (approvedContributions === 0) return [];
      return [
        {
          membershipId,
          approvedMinutes: count(row.minutes),
          approvedContributions,
        },
      ];
    })
    .sort(
      (a, b) =>
        b.approvedMinutes - a.approvedMinutes ||
        b.approvedContributions - a.approvedContributions ||
        a.membershipId.localeCompare(b.membershipId),
    )
    .slice(0, Math.max(0, limit));
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Maps per-member roster rows (`membership_id`, `minutes`, `approved`,
 * `pending`, `unknown`, `week_minutes`) to the staff volunteer roster. Rows
 * without a resolved member or without any contribution in scope are
 * dropped. Pending rows contribute counts only, never minutes. The week
 * figure is null when the report week is unknown, never a guessed zero.
 * Ordered by approved minutes descending, then membership id by code unit
 * (matching the SQL `collate "C"` order), and cut at `limit`.
 */
export function volunteerRoster(
  rows: readonly ReportRow[],
  options: { weekKnown: boolean; limit?: number },
): { volunteers: ReportVolunteer[]; volunteersTruncated: boolean } {
  const limit = Math.max(0, options.limit ?? REPORT_VOLUNTEERS_LIMIT);
  const all = rows
    .flatMap((row): ReportVolunteer[] => {
      const membershipId = row.membership_id;
      if (typeof membershipId !== "string" || !membershipId) return [];
      const approvedContributions = count(row.approved);
      const pendingContributions = count(row.pending);
      if (approvedContributions + pendingContributions === 0) return [];
      return [
        {
          membershipId,
          approvedMinutes: approvedContributions ? count(row.minutes) : 0,
          weekApprovedMinutes: options.weekKnown
            ? count(row.week_minutes)
            : null,
          approvedContributions,
          pendingContributions,
          pendingUnknownDuration: Math.min(
            count(row.unknown),
            pendingContributions,
          ),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.approvedMinutes - a.approvedMinutes ||
        byCodeUnit(a.membershipId, b.membershipId),
    );
  return {
    volunteers: all.slice(0, limit),
    volunteersTruncated: all.length > limit,
  };
}

/**
 * Builds the report projection from aggregate rows. Staff-only inputs
 * (`contributors`, `oldestQueued`, `volunteers`) are passed as null for
 * aggregate-only readers, and the corresponding fields are then omitted
 * entirely.
 */
export function buildProductReport(input: {
  query: ReportQuery;
  timezone: string;
  totals: ReportRow;
  needs: ReportRow;
  unknownDate: ReportRow;
  weekRange: ReportWeekRange | null;
  week: ReportRow | null;
  contributors: readonly ReportRow[] | null;
  oldestQueued: ReportRow | null;
  volunteers?: readonly ReportRow[] | null;
}): ProductReport {
  const { query: q, totals: r, needs: n } = input;
  const minutes = count(r.minutes);
  const weekMinutes =
    input.weekRange && input.week ? count(input.week.minutes) : null;
  return {
    query: q,
    timezone: input.timezone,
    ledger: {
      approvedMinutes: minutes,
      approvedContributions: count(r.approved),
      activitiesWithApprovedContributions: count(r.visits),
      pendingContributions: count(r.pending),
      pendingUnknownDuration: count(r.unknown),
      pendingUnresolvedVolunteer: count(r.unresolved),
    },
    approvedHours: minutes / 60,
    openNeeds: count(n.open),
    resolvedNeeds: count(n.resolved),
    averageAcknowledgmentMinutes: nullableNumber(n.ack),
    averageResolutionMinutes: nullableNumber(n.resolution),
    excludedUnknownDate: q.from || q.to ? count(input.unknownDate.count) : 0,
    weekRange: weekMinutes === null ? null : input.weekRange,
    weekApprovedMinutes: weekMinutes,
    weekHours: weekMinutes === null ? null : weekMinutes / 60,
    unassignedOpenNeeds: count(n.unassigned),
    ...(input.contributors
      ? { topContributors: topContributors(input.contributors) }
      : {}),
    ...(input.oldestQueued
      ? { oldestQueuedReviewAt: instant(input.oldestQueued.oldest) }
      : {}),
    ...(input.volunteers
      ? volunteerRoster(input.volunteers, { weekKnown: weekMinutes !== null })
      : {}),
  };
}

/**
 * The aggregate CSV export. Columns are the original aggregate set followed by
 * additive week and needs columns. Per-member and staff-only fields
 * (topContributors, oldestQueuedReviewAt, volunteers) and any evidence
 * identifiers are deliberately excluded: the export stays one aggregate row.
 */
export function reportCsv(report: ProductReport) {
  const q = report.query;
  const fields = {
    timezone: report.timezone,
    from: q.from ?? "",
    to: q.to ?? "",
    program: q.program ?? "",
    membershipId: q.membershipId ?? "",
    approvedMinutes: report.ledger.approvedMinutes,
    approvedContributions: report.ledger.approvedContributions,
    activitiesWithApprovedContributions:
      report.ledger.activitiesWithApprovedContributions,
    pendingContributions: report.ledger.pendingContributions,
    pendingUnknownDuration: report.ledger.pendingUnknownDuration,
    pendingUnresolvedVolunteer: report.ledger.pendingUnresolvedVolunteer,
    approvedHours: report.approvedHours,
    openNeeds: report.openNeeds,
    resolvedNeeds: report.resolvedNeeds,
    averageAcknowledgmentMinutes: report.averageAcknowledgmentMinutes,
    averageResolutionMinutes: report.averageResolutionMinutes,
    excludedUnknownDate: report.excludedUnknownDate,
    weekFrom: report.weekRange?.from ?? "",
    weekTo: report.weekRange?.to ?? "",
    weekApprovedMinutes: report.weekApprovedMinutes,
    weekHours: report.weekHours,
    unassignedOpenNeeds: report.unassignedOpenNeeds,
  };
  return `${Object.keys(fields).map(csvCell).join(",")}\r\n${Object.values(
    fields,
  )
    .map(csvCell)
    .join(",")}\r\n`;
}
