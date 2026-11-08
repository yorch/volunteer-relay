import type {
  AuthOrganizationOption,
  ContributionRecord,
  LedgerSummary,
  NeedRecord,
  ReviewQueueEntry,
} from "./index.ts";

/** Server-authorized workspace projection. Private arrays are empty for readers. */
export interface WorkspaceSnapshot {
  organization: AuthOrganizationOption;
  members: Array<{ membershipId: string; name: string }>;
  sources: Array<{
    sourceId: string;
    revision: number;
    status: "queued" | "failed" | "review" | "accepted" | "rejected";
  }>;
  queue: ReviewQueueEntry[];
  contributions: ContributionRecord[];
  needs: NeedRecord[];
  summary: LedgerSummary | null;
}

export const productEndpoints = {
  workspace: "/api/product/workspace",
  sources: "/api/product/sources",
  review: "/api/product/review",
  activity: "/api/product/activity",
  contribution: "/api/product/contribution",
  need: "/api/product/need",
  needTransition: "/api/product/need-transition",
} as const;
