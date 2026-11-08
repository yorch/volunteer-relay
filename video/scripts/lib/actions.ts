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
 * records the on-screen regions the composition annotates, and asserts persisted
 * totals. A failed assertion aborts the take instead of rendering a plausible
 * but wrong scene.
 */

export interface ActionContext {
  page: Page;
  target: CaptureTarget;
  scenario: RecordingScenario;
  expected: ExpectedResults;
  /** Records a timestamped action marker for the capture manifest. */
  mark: (label: string) => void;
  /** Moves the visible pointer, then clicks. */
  click: (locator: Locator) => Promise<void>;
  /** Moves the pointer to the field and types at a human pace. */
  typeInto: (locator: Locator, text: string) => Promise<void>;
  /** Clicks the field, then sets a non-text value (dates, selects). */
  fill: (locator: Locator, value: string) => Promise<void>;
  /** Records one element (or the union of several) for spotlight annotation. */
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
      await context.region(
        "queue",
        page
          .getByRole("heading", { name: /Awaiting review/ })
          .locator("xpath=ancestor::section[1]"),
      );
      await context.click(
        page.locator('input[name="search"], input[type="search"]'),
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
      const original = page.getByRole("heading", { name: "Original update" });
      await original.waitFor();
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
      // Record after the interaction settles, so boxes match the final view.
      await context.region("evidence", evidence);
      await context.region("contributions", [
        durations.nth(0),
        durations.nth(1),
      ]);
      await context.region(
        "proposal",
        page
          .locator("section")
          .filter({
            has: page.getByRole("heading", { name: "Proposed fields" }),
          })
          .first(),
      );
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
      await context.region("accept", accept);
      await context.click(accept);
      await page.getByText("Proposal accepted.").waitFor();
      mark("accepted");
      // Navigate by clicking the real nav item, but never depend on SPA timing:
      // if the client route does not settle, load the page directly.
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
      const rows = page.getByRole("listitem");
      const rowCount = await rows.count();
      if (rowCount >= 2)
        await context.region("ledger-pair", [rows.nth(0), rows.nth(1)]);
      await context.region(
        "ledger",
        page.getByRole("heading", { name: "Contribution ledger" }),
      );
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
      await context.region("duplicate", unresolved);
      const reason = page.getByLabel(/Review reason/);
      await context.region("reason", reason);
      await context.typeInto(reason, "Duplicate of the approved garden visit.");
      mark("reason-typed");
      const reject = page.getByRole("button", { name: "Reject proposal" });
      await context.click(reject);
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
      await context.region("need", card);

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
      await context.region("owner", owner);
      await context.click(owner);
      await owner.selectOption({ label: "Demo Owner" });
      const deadline = card.getByLabel("Acknowledge by");
      await context.fill(deadline, "2026-11-12T17:00");
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
      await context.region(
        "status",
        card.getByText("acknowledged", { exact: true }),
      );

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
      const from = page.getByLabel("From date");
      await context.fill(from, scenario.dateWindow.from);
      const to = page.getByLabel("To date");
      await context.fill(to, scenario.dateWindow.to);
      const apply = page.getByRole("button", { name: "Apply filters" });
      await context.click(apply);
      await page.getByRole("heading", { name: "Approved hours" }).waitFor();
      mark("report-filtered");
      await context.region("filter", page.locator("section").first());
      const minutes = page.getByRole("row", { name: /Approved minutes/ });
      const text = (await minutes.textContent()) ?? "";
      if (!/300/.test(text))
        throw new Error(`Approved minutes should be 300, saw: ${text}`);
      await context.region("metrics", [
        page
          .getByRole("heading", { name: "Approved hours" })
          .locator("xpath=ancestor::section[1]"),
        page
          .getByRole("heading", { name: "Pending contributions" })
          .locator("xpath=ancestor::section[1]"),
      ]);
      await context.region(
        "table",
        page
          .getByRole("heading", { name: "At a glance" })
          .locator("xpath=ancestor::section[1]"),
      );
      const pending = page.getByRole("heading", {
        name: "Pending contributions",
      });
      await pending.waitFor();
      mark("pending-visible");
    },
  },
};

export type RegionMap = Record<string, Box>;
