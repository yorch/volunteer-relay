import type { Page } from "@playwright/test";
import type {
  ExpectedResults,
  ObservedTotals,
  RecordingScenario,
} from "../../src/lib/scenario.ts";
import { compareTotals } from "../../src/lib/scenario.ts";
import type { CaptureTarget } from "../../src/lib/target.ts";
import { readTotals } from "./totals.ts";

/**
 * Typed capture actions, one per product scene. Each entry proves the visible
 * state it records and asserts persisted totals; a failed assertion aborts the
 * take instead of rendering a plausible but wrong scene.
 */

export interface ActionContext {
  page: Page;
  target: CaptureTarget;
  scenario: RecordingScenario;
  expected: ExpectedResults;
  /** Records a timestamped action marker for the capture manifest. */
  mark: (label: string) => void;
}

export interface SceneAction {
  /** Checkpoint the scene begins from. */
  startsFrom: string;
  /** Checkpoint the scene must establish (or preserve) when it ends. */
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

async function selectReviewItem(page: Page, text: string): Promise<void> {
  await page
    .getByRole("button", { name: new RegExp(text) })
    .first()
    .click();
  await page.getByRole("heading", { name: "Proposed fields" }).waitFor();
}

export const sceneActions: Record<string, SceneAction> = {
  S02: {
    startsFrom: "baseline",
    establishes: null,
    async run({ page, mark }) {
      await page.getByRole("heading", { name: "Source inbox" }).waitFor();
      const awaiting = page.getByRole("heading", { name: /Awaiting review/ });
      await awaiting.waitFor();
      const text = (await awaiting.textContent()) ?? "";
      mark("inbox-loading");
      if (!/\b7\b/.test(text))
        throw new Error(
          `The review queue count is not the authored baseline: ${text}`,
        );
      mark("queue-verified");
    },
  },
  S03: {
    startsFrom: "baseline",
    establishes: null,
    async run({ page, mark }) {
      mark("inbox-ready");
      await selectReviewItem(page, SHARED_REVIEW_TEXT);
      mark("review-opened");
      const original = page.getByRole("heading", { name: "Original update" });
      await original.waitFor();
      const evidence = page
        .locator("p")
        .filter({ hasText: "planted seedlings" });
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
      mark("proposal-verified");
    },
  },
  S04: {
    startsFrom: "baseline",
    establishes: "after-s04",
    async run(context) {
      const { page, mark } = context;
      await selectReviewItem(page, SHARED_REVIEW_TEXT);
      mark("proposal-open");
      await page.getByRole("button", { name: "Accept proposal" }).click();
      await page.getByText("Proposal accepted.").waitFor();
      mark("accepted");
      await page.goto(`${context.target.baseUrl}/workspace/activities`, {
        waitUntil: "domcontentloaded",
      });
      await page
        .getByRole("heading", { name: "Contribution ledger" })
        .waitFor();
      mark("ledger-visible");
    },
  },
  S05: {
    startsFrom: "after-s04",
    establishes: "after-s05",
    async run({ page, mark }) {
      await page.getByRole("heading", { name: "Source inbox" }).waitFor();
      await selectReviewItem(page, DUPLICATE_TEXT);
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
      await page
        .getByLabel(/Review reason/)
        .fill("Duplicate of the approved garden visit.");
      mark("reason-entered");
      await page.getByRole("button", { name: "Reject proposal" }).click();
      await page.getByText("Proposal rejected.").waitFor();
      mark("rejected");
    },
  },
  S06: {
    startsFrom: "after-s05",
    establishes: "after-s06",
    async run({ page, target, mark }) {
      await page.getByRole("heading", { name: "Needs board" }).waitFor();
      // Anchor on the need's own heading, then its nearest card section: the
      // outer workspace wrapper also matches a section filter.
      const card = page
        .getByRole("heading", { name: URGENT_NEED })
        .locator("xpath=ancestor::section[1]");
      await card.waitFor();
      mark("needs-board");

      /**
       * The manage panel collapses whenever the need changes revision, and the
       * details node is replaced. Toggle until the action select exposes the
       * action we need; the snapshot refresh lands a beat after the notice.
       */
      async function selectAction(desired: "assign" | "acknowledge") {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const select = card.getByLabel("Action");
          if (!(await select.isVisible()))
            await card.locator("details").first().locator("summary").click();
          try {
            await select.waitFor({ state: "visible", timeout: 2_000 });
            const available = await select
              .locator("option")
              .evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value),
              );
            if (available.includes(desired)) {
              await select.selectOption(desired);
              return;
            }
          } catch {
            // Detached mid-render; retry with the fresh node.
          }
          await card
            .getByText("Need updated.")
            .waitFor({ timeout: 1_000 })
            .catch(() => {});
        }
        throw new Error(
          `The need's manage panel never exposed the ${desired} action`,
        );
      }

      await selectAction("assign");
      await card.getByLabel("Owner").selectOption({ label: "Demo Owner" });
      await card.getByLabel("Acknowledge by").fill("2026-11-12T17:00");
      mark("assignment-filled");
      await card.getByRole("button", { name: "Update need" }).click();
      await page.getByText("Need updated.").waitFor();
      await card.getByText("assigned", { exact: true }).waitFor();
      mark("assigned");

      await selectAction("acknowledge");
      await card.getByRole("button", { name: "Update need" }).click();
      await page.getByText("Need updated.").waitFor();
      await card.getByText("acknowledged", { exact: true }).waitFor();
      mark("acknowledged");

      const workspace = await page.request.get(
        `${target.baseUrl}/api/product/workspace`,
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
    async run({ page, scenario, mark }) {
      await page.getByRole("heading", { name: "Summary" }).waitFor();
      await page.getByLabel("From date").fill(scenario.dateWindow.from);
      await page.getByLabel("To date").fill(scenario.dateWindow.to);
      await page.getByRole("button", { name: "Apply filters" }).click();
      await page.getByRole("heading", { name: "Approved hours" }).waitFor();
      mark("report-filtered");
      const minutes = page.getByRole("row", { name: /Approved minutes/ });
      const text = (await minutes.textContent()) ?? "";
      if (!/300/.test(text))
        throw new Error(`Approved minutes should be 300, saw: ${text}`);
      const pending = page.getByRole("heading", {
        name: "Pending contributions",
      });
      await pending.waitFor();
      mark("pending-visible");
    },
  },
};
