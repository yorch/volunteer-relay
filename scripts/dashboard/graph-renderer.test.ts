import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { expect, test } from "vitest";

const source = readFileSync(
  new URL("./graph-renderer.js", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("./graph-renderer.css", import.meta.url),
  "utf8",
);
const node = (id: string) => ({
  id,
  kind: "lane",
  label: id,
  role: null,
  harness: null,
  observedModel: null,
  taskId: null,
  processStatus: null,
  taskStatus: null,
  accepted: false,
});
const edge = (
  id: string,
  from: string,
  to: string,
  kind = "awaiting-answer",
) => ({
  id,
  from,
  to,
  kind,
  label: id,
  threadId: `opaque:${id}`,
  at: null,
  unanswered: true,
});

test("synthetic graph: bounded fanout, cycles, hostile text, missing references, filters and stable keyboard updates across viewports", async () => {
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent('<main id="host"></main>');
    await page.addStyleTag({ content: css });
    await page.addScriptTag({
      type: "module",
      content: `${source}\nwindow.renderGraph = renderGraph;`,
    });
    await page.waitForFunction("typeof window.renderGraph === 'function'");
    const snapshot = {
      version: 1,
      view: "communication",
      nodes: [
        node("D"),
        node("A"),
        node('<img src=x onerror="window.pwned=true">'),
      ],
      edges: [
        edge("question", "D", "A"),
        edge("cycle", "A", "D", "review-handoff"),
        edge("missing", "D", "absent"),
        edge("dependency", "A", "D", "dependency"),
      ],
      hidden: { nodes: 4, edges: 8 },
    };
    await page.evaluate((data) => {
      const runtime = window as unknown as {
        renderGraph: (
          document: Document,
          host: Element,
          snapshot: unknown,
          options: unknown,
        ) => unknown;
        graph: unknown;
        selected: unknown;
      };
      runtime.graph = runtime.renderGraph(
        document,
        document.querySelector("#host") ?? document.body,
        data,
        {
          onSelect: (selection: unknown) => {
            runtime.selected = selection;
          },
        },
      );
    }, snapshot);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.locator("tbody tr").count()).toBe(3);
    await expectText(
      page.locator('[role="status"]'),
      "Missing-reference relationships: 1",
    );
    const first = page.locator(".relay-graph-nodes button").first();
    await first.focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate("window.selected")).toEqual({
      kind: "lane",
      id: "D",
    });
    await page.evaluate(
      (data) => {
        (
          window as unknown as { graph: { update: (value: unknown) => void } }
        ).graph.update(data);
      },
      {
        ...snapshot,
        nodes: [
          { ...snapshot.nodes[0], processStatus: "running" },
          ...snapshot.nodes.slice(1),
        ],
      },
    );
    expect(
      await first.evaluate((element) => element === document.activeElement),
    ).toBe(true);
    expect(await first.getAttribute("aria-pressed")).toBe("true");
    await page.locator("tbody button").first().focus();
    await page.keyboard.press("Space");
    expect(await page.evaluate("window.selected")).toEqual({
      kind: "thread",
      id: "opaque:question",
    });
    await page.locator("details").evaluate((element) => {
      (element as HTMLDetailsElement).open = false;
    });
    await page.evaluate((data) => {
      (
        window as unknown as { graph: { update: (value: unknown) => void } }
      ).graph.update(data);
    }, snapshot);
    expect(await page.locator("details").getAttribute("open")).toBe(null);
    await page.locator("details").evaluate((element) => {
      (element as HTMLDetailsElement).open = true;
    });
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `/private/tmp/relay-D-P0-21-${width}.png`,
        fullPage: true,
      });
    }
    await page.getByRole("searchbox").fill("no match");
    expect(await page.locator(".relay-graph-nodes button").count()).toBe(0);
    await expectText(page.locator('[role="status"]'), "No matching nodes");
    await page.getByRole("searchbox").fill("");
    const fanout = {
      ...snapshot,
      view: "dependencies",
      nodes: Array.from({ length: 55 }, (_, index) => node(`n${index}`)),
      edges: Array.from({ length: 105 }, (_, index) =>
        edge(`e${index}`, "n0", `n${index % 55}`, "dependency"),
      ),
    };
    await page.evaluate((data) => {
      (
        window as unknown as { graph: { update: (value: unknown) => void } }
      ).graph.update(data);
    }, fanout);
    expect(await page.locator(".relay-graph-nodes button").count()).toBe(50);
    expect(await page.locator("tbody tr").count()).toBe(100);
    await expectText(
      page.locator('[role="status"]'),
      "Truncated: 5 nodes, 5 edges",
    );
    await page.getByRole("combobox").selectOption("task");
    expect(await page.locator(".relay-graph-nodes button").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.evaluate(() => {
      (window as unknown as { graph: { destroy: () => void } }).graph.destroy();
    });
    expect(await page.locator("#host").textContent()).toBe("");
  } finally {
    await browser.close();
  }
}, 30000);

async function expectText(
  locator: { textContent(): Promise<string | null> },
  text: string,
) {
  expect(await locator.textContent()).toContain(text);
}
