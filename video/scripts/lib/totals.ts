import type { Page } from "@playwright/test";
import type {
  ObservedTotals,
  RecordingScenario,
} from "../../src/lib/scenario.ts";
import type { CaptureTarget } from "../../src/lib/target.ts";

/**
 * Read the application's own projections and turn them into the totals the
 * authored oracle compares against. Numbers always come from the app, never
 * from a fixture read at runtime.
 */

interface WorkspaceValue {
  sources?: unknown[];
  queue?: unknown[];
}

interface ReportValue {
  ledger?: {
    approvedMinutes?: number;
    approvedContributions?: number;
    activitiesWithApprovedContributions?: number;
    pendingContributions?: number;
    pendingUnknownDuration?: number;
  };
  openNeeds?: number;
  resolvedNeeds?: number;
}

async function readJson<T>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok())
    throw new Error(`${url} returned HTTP ${response.status()}`);
  const body = (await response.json()) as { ok?: boolean; value?: T };
  if (!body.ok || body.value === undefined)
    throw new Error(`${url} did not return a value`);
  return body.value;
}

export async function readTotals(
  page: Page,
  target: CaptureTarget,
  scenario: RecordingScenario,
): Promise<ObservedTotals> {
  const workspace = await readJson<WorkspaceValue>(
    page,
    `${target.baseUrl}/api/product/workspace`,
  );
  const query = new URLSearchParams({
    from: scenario.dateWindow.from,
    to: scenario.dateWindow.to,
  });
  const report = await readJson<ReportValue>(
    page,
    `${target.baseUrl}/api/product/reports?${query.toString()}`,
  );
  const ledger = report.ledger;
  if (!ledger) throw new Error("Report has no ledger summary");
  return {
    sources: workspace.sources?.length ?? 0,
    reviewQueue: workspace.queue?.length ?? 0,
    approvedMinutes: ledger.approvedMinutes ?? 0,
    approvedContributions: ledger.approvedContributions ?? 0,
    activitiesWithApprovedContributions:
      ledger.activitiesWithApprovedContributions ?? 0,
    pendingContributions: ledger.pendingContributions ?? 0,
    pendingUnknownDuration: ledger.pendingUnknownDuration ?? 0,
    openNeeds: report.openNeeds ?? 0,
    resolvedNeeds: report.resolvedNeeds ?? 0,
  };
}
