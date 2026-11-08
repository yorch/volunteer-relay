import type { Locator, Page } from "@playwright/test";
import type {
  ExpectedResults,
  ObservedTotals,
  RecordingScenario,
} from "../../src/lib/scenario.ts";
import { compareTotals } from "../../src/lib/scenario.ts";
import type { Box } from "../../src/lib/schema.ts";
import type { CaptureTarget } from "../../src/lib/target.ts";
import { readTotals } from "./totals.ts";

/**
 * Typed capture actions, one per product scene. Each entry proves the visible
 * state it records, performs the action with a visible pointer and real typing,
 * records only *stable* element boxes (page-level headings: the workspace scrolls
 * its panes, so inner elements drift), and asserts persisted totals. A failed
 * assertion aborts the take instead of rendering a plausible but wrong scene.
 */

export interface ActionContext {
  page: Page;
  target: CaptureTarget;
  scenario: RecordingScenario;
  expected: ExpectedResults;
  mark: (label: string) => void;
  click: (locator: Locator) => Promise<void>;
  typeInto: (locator: Locator, text: string) => Promise<void>;
  fill: (locator: Locator, value: string) => Promise<void>;
  region: (label: string, locators: Locator | Locator[]) => Promise<void>;
}

export interface SceneAction {
  startsFrom: string;
  establishes: string | null;
  run: (context: ActionContext) => Promise<void>;
}

const URGENT_NEED = "Urgent: a family needs transport today.";
const SHARED_REVIEW_TEXT = "each planted seedlings for 60 minutes";
const DUPLICATE_TEXT = "reported the same community garden visit earlier";

export async function assertTotals(
  context: ActionContext,
  checkpointId: string,
): Promise<ObservedTotals> {
  const expected =
    checkpointId === "baseline"
      ? context.expected.baseline
      : context.expected.checkpoints[checkpointId];
  if (!expected)
    throw new Error(
      `No authored expectation for checkpoint ${checkpointId}. Update fixtures/expected-results.json first.`,
    );
  const observed = await readTotals(
    context.page,
    context.target,
    context.scenario,
  );
  const comparison = compareTotals(expected, observed);
  if (!comparison.ok)
    throw new Error(
      `${checkpointId} does not match the authored oracle: ${comparison.mismatches
        .map((m) => `${m.field} expected ${m.expected}, observed ${m.observed}`)
        .join("; ")}`,
    );
  return observed;
}

async function selectReviewItem(
  context: ActionContext,
  text: string,
): Promise<void> {
  const item = context.page
    .getByRole("button", { name: new RegExp(text) })
    .first();
  await context.click(item);
  await context.page
    .getByRole("heading", { name: "Proposed fields" })
    .waitFor();
}

/** The page heading is outside every scroll container: safe to annotate. */
function pageHeading(context: ActionContext): Locator {
  return context.page.getByRole("heading", { level: 1 });
}

export const sceneActions: Record<string, SceneAction> = {
  S02: {
    startsFrom: "baseline",
    establishes: null,
    async run(context) {
      const { page, mark } = context;
      await page.getByRole("heading", { name: "Source inbox" }).waitFor();
      const awaiting = page.getByRole("heading", { name: /Awaiting review/ });
      await awaiting.waitFor();
      const text = (await awaiting.textContent()) ?? "";
      mark("inbox-loading");
      if (!/\b7\b/.test(text))
        throw new Error(
          `The review queue count is not the authored baseline: ${text}`,
        );
      await context.region("heading", pageHeading(context));
      await context.click(
        page.locator('input[name="search"], input[type="search"]').first(),
      );
      await page.keyboard.press("Escape");
      mark("queue-verified");
    },
  },
  S03: {
    startsFrom: "baseline",
    establishes: null,
    async run(context) {
      const { page, mark } = context;
      mark("inbox-ready");
      await selectReviewItem(context, SHARED_REVIEW_TEXT);
      mark("review-opened");
      await page.getByRole("heading", { name: "Original update" }).waitFor();
      const evidence = page
        .locator("p")
        .filter({ hasText: "planted seedlings" })
        .first();
      if ((await evidence.count()) === 0)
        throw new Error("The original update text is not visible");
      const durations = page.getByLabel(/Duration in minutes/);
      const count = await durations.count();
      if (count < 2)
        throw new Error(
          `Expected two proposed contributions, found ${count} duration fields`,
        );
      for (let index = 0; index < count; index += 1) {
        const value = await durations.nth(index).inputValue();
        if (value !== "60")
          throw new Error(`Proposed duration ${index + 1} is ${value}, not 60`);
      }
      await context.click(durations.nth(1));
      await page.keyboard.press("Tab");
      mark("proposal-verified");
      await context.region("heading", pageHeading(context));
    },
  },
  S04: {
    startsFrom: "baseline",
    establishes: "after-s04",
    async run(context) {
      const { page, mark } = context;
      await selectReviewItem(context, SHARED_REVIEW_TEXT);
      mark("proposal-open");
      const accept = page.getByRole("button", { name: "Accept proposal" });
      await context.click(accept);
      await page.getByText("Proposal accepted.").waitFor();
      mark("accepted");

      // Navigate by clicking the real nav item; fall back to a direct load so
      // client-route timing can never stall the take.
      await context.click(
        page.getByRole("link", { name: "Activities" }).first(),
      );
      await page
        .waitForURL(/\/workspace\/activities/, { timeout: 10_000 })
        .catch(async () => {
          await page.goto(`${context.target.baseUrl}/workspace/activities`, {
            waitUntil: "domcontentloaded",
          });
        });
      await page
        .getByRole("heading", { name: "Contribution ledger" })
        .waitFor({ timeout: 20_000 });
      mark("ledger-visible");

      // Prove the record traces to its source: open the garden visit's evidence
      // instead of leaving a list of identical-looking contribution rows.
      await context.click(
        page
          .getByRole("button", { name: "Inspect current source evidence" })
          .first(),
      );
      await page
        .getByText(/planted seedlings/)
        .first()
        .waitFor();
      mark("evidence-opened");
      await context.region("heading", pageHeading(context));
    },
  },
  S05: {
    startsFrom: "after-s04",
    establishes: "after-s05",
    async run(context) {
      const { page, mark } = context;
      await page.getByRole("heading", { name: "Source inbox" }).waitFor();
      await selectReviewItem(context, DUPLICATE_TEXT);
      mark("duplicate-open");
      const unresolved = page.getByRole("heading", {
        name: "Unresolved in original proposal",
      });
      await unresolved.waitFor();
      const body =
        (await page
          .locator("section", { has: unresolved })
          .first()
          .textContent()) ?? "";
      if (!/duplicate candidate/i.test(body))
        throw new Error(
          `The possible-duplicate flag is not visible in the review pane. Saw: ${body.slice(0, 400)}`,
        );
      await context.region("heading", pageHeading(context));
      const reason = page.getByLabel(/Review reason/);
      await context.typeInto(reason, "Duplicate of the approved garden visit.");
      mark("reason-typed");
      await context.click(
        page.getByRole("button", { name: "Reject proposal" }),
      );
      await page.getByText("Proposal rejected.").waitFor();
      mark("rejected");
    },
  },
  S06: {
    startsFrom: "after-s05",
    establishes: "after-s06",
    async run(context) {
      const { page, mark } = context;
      await page.getByRole("heading", { name: "Needs board" }).waitFor();
      const card = page
        .getByRole("heading", { name: URGENT_NEED })
        .locator("xpath=ancestor::section[1]");
      await card.waitFor();
      mark("needs-board");
      await context.region("heading", pageHeading(context));

      async function selectAction(desired: "assign" | "acknowledge") {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const summary = card.locator("details").first().locator("summary");
          const select = card.getByLabel("Action");
          if (!(await select.isVisible())) await context.click(summary);
          try {
            await select.waitFor({ state: "visible", timeout: 2_000 });
            const available = await select
              .locator("option")
              .evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value),
              );
            if (available.includes(desired)) {
              await context.click(select);
              await select.selectOption(desired);
              return;
            }
          } catch {
            // Detached mid-render; retry with the fresh node.
          }
        }
        throw new Error(
          `The need's manage panel never exposed the ${desired} action`,
        );
      }

      await selectAction("assign");
      const owner = card.getByLabel("Owner");
      await context.click(owner);
      await owner.selectOption({ label: "Demo Owner" });
      await context.fill(card.getByLabel("Acknowledge by"), "2026-11-12T17:00");
      mark("assignment-filled");
      await context.click(card.getByRole("button", { name: "Update need" }));
      await page.getByText("Need updated.").waitFor();
      await card.getByText("assigned", { exact: true }).waitFor();
      mark("assigned");

      await selectAction("acknowledge");
      await context.click(card.getByRole("button", { name: "Update need" }));
      await page.getByText("Need updated.").waitFor();
      await card.getByText("acknowledged", { exact: true }).waitFor();
      mark("acknowledged");

      const workspace = await page.request.get(
        `${context.target.baseUrl}/api/product/workspace`,
        { headers: { accept: "application/json" } },
      );
      const body = (await workspace.json()) as {
        ok?: boolean;
        value?: { needs?: Array<{ summary?: string; status?: string }> };
      };
      const need = body.value?.needs?.find(
        (entry) => entry.summary === URGENT_NEED,
      );
      if (need?.status !== "acknowledged")
        throw new Error(
          `The urgent need is ${String(need?.status)}, not acknowledged, after the staff action`,
        );
    },
  },
  S07: {
    startsFrom: "after-s06",
    establishes: null,
    async run(context) {
      const { page, scenario, mark } = context;
      await page.getByRole("heading", { name: "Summary" }).waitFor();
      await context.fill(
        page.getByLabel("From date"),
        scenario.dateWindow.from,
      );
      await context.fill(page.getByLabel("To date"), scenario.dateWindow.to);
      await context.click(page.getByRole("button", { name: "Apply filters" }));
      await page.getByRole("heading", { name: "Approved hours" }).waitFor();
      mark("report-filtered");
      await context.region("heading", pageHeading(context));
      const minutes = page.getByRole("row", { name: /Approved minutes/ });
      const text = (await minutes.textContent()) ?? "";
      if (!/300/.test(text))
        throw new Error(`Approved minutes should be 300, saw: ${text}`);
      await page
        .getByRole("heading", { name: "Pending contributions" })
        .waitFor();
      mark("pending-visible");
    },
  },
};

export type RegionMap = Record<string, Box>;
