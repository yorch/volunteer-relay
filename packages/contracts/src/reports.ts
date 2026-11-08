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
}
