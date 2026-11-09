import { expect, type Page, test } from "@playwright/test";

// Audits every visible text-bearing element (links and buttons included) on
// the workspace routes: empty states (where button-like links in cards were
// once teal on teal), a populated workspace, and a few interactive states
// (open inbox detail, command palette, hover and keyboard focus).
const organization = {
  organizationId: "org-1",
  name: "Community",
  slug: "community",
  role: "owner",
  membershipId: "member-1",
};
const emptySnapshot = {
  organization,
  members: [],
  sources: [],
  queue: [],
  contributions: [],
  needs: [],
  summary: null,
};
const ledger = {
  approvedMinutes: 135,
  approvedContributions: 3,
  activitiesWithApprovedContributions: 2,
  pendingContributions: 3,
  pendingUnknownDuration: 2,
  pendingUnresolvedVolunteer: 1,
};
const populatedSnapshot = {
  ...emptySnapshot,
  members: [
    { membershipId: "member-1", name: "Alex" },
    { membershipId: "member-2", name: "Bea" },
  ],
  sources: [
    { sourceId: "failed-1", revision: 2, status: "failed" },
    { sourceId: "pending-1", revision: 1, status: "received" },
  ],
  queue: [
    {
      source: {
        sourceId: "source-1",
        revision: 2,
        text: "Helped for 90 minutes at the garden",
        channel: "web",
        receivedAt: "2026-01-01T00:00:00Z",
        attachments: [
          { id: "photo-1", storageKey: "x", mimeType: "image/png" },
        ],
      },
      revision: 3,
      proposal: {
        runId: "run-1",
        items: [
          {
            kind: "contribution",
            key: "item-1",
            activityKey: "activity-1",
            membershipId: null,
            durationMinutes: 90,
            evidence: [
              {
                kind: "text",
                field: "durationMinutes",
                quote: "90 minutes",
                start: 11,
                end: 21,
                sourceRevision: 2,
              },
            ],
          },
        ],
        unresolved: [{ field: "membershipId", reason: "Unknown volunteer" }],
      },
    },
    {
      source: {
        sourceId: "source-2",
        revision: 1,
        text: "Delivered supplies",
        channel: "telegram",
        receivedAt: "2026-01-02T00:00:00Z",
      },
      revision: 1,
      proposal: { runId: "run-2", items: [], unresolved: [] },
    },
  ],
  contributions: [
    {
      schemaVersion: 1,
      organizationId: "org-1",
      contributionId: "c-1",
      activityId: "a-1",
      revision: 1,
      membershipId: "member-1",
      durationMinutes: null,
      status: "pending",
      origin: { kind: "staff", reason: "Entry" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      schemaVersion: 1,
      organizationId: "org-1",
      contributionId: "c-2",
      activityId: "a-2",
      revision: 1,
      membershipId: "member-2",
      durationMinutes: 60,
      status: "approved",
      origin: { kind: "staff", reason: "Entry" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
  needs: [
    {
      needId: "n1",
      summary: "Deliver supplies",
      status: "new",
      urgency: "urgent",
      provisional: false,
      dueAt: null,
    },
    {
      needId: "n2",
      summary: "Staff the front table",
      status: "acknowledged",
      urgency: "normal",
      provisional: true,
      dueAt: null,
    },
  ],
  summary: ledger,
};
const report = {
  query: { from: "2026-11-01", to: "2026-11-30" },
  timezone: "UTC",
  ledger,
  approvedHours: 2.25,
  openNeeds: 2,
  resolvedNeeds: 1,
  averageAcknowledgmentMinutes: 12,
  excludedUnknownDate: 1,
  weekRange: { from: "2026-11-02", to: "2026-11-08" },
  weekApprovedMinutes: 45,
  weekHours: 0.75,
  topContributors: [
    {
      membershipId: "member-1",
      approvedMinutes: 135,
      approvedContributions: 3,
    },
  ],
  volunteers: [
    {
      membershipId: "member-1",
      approvedMinutes: 135,
      weekApprovedMinutes: 45,
      approvedContributions: 3,
      pendingContributions: 1,
      pendingUnknownDuration: 0,
    },
    {
      membershipId: "member-2",
      approvedMinutes: 0,
      weekApprovedMinutes: 0,
      approvedContributions: 0,
      pendingContributions: 1,
      pendingUnknownDuration: 1,
    },
  ],
  volunteersTruncated: false,
};

const routes = [
  "/workspace",
  "/workspace/inbox",
  "/workspace/needs",
  "/workspace/activities",
  "/workspace/reports",
  "/workspace/import",
  "/workspace/history",
  "/workspace/delivery",
  "/workspace/retention",
  "/workspace/notifications",
  "/workspace/settings",
  "/workspace/members",
];

async function mock(page: Page, snapshot: unknown, reportValue: unknown) {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports*", (route) =>
    route.fulfill({ json: { ok: true, value: reportValue } }),
  );
  await page.route("**/api/product/notifications*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: [
          { id: "a", readAt: null },
          { id: "b", readAt: "2026-01-01" },
        ],
      },
    }),
  );
}

/** Contrast failures for every visible text element under the document body. */
async function audit(page: Page, label: string): Promise<string[]> {
  const found = await page.locator("body").evaluate((root) => {
    // rgb()/rgba() use 0-255 channels; color(srgb ...) (from color-mix) uses 0-1.
    const parse = (s: string) => {
      const n = (s.match(/[\d.]+/g) ?? []).map(Number);
      return s.startsWith("color(")
        ? n.map((v, i) => (i < 3 ? v * 255 : v))
        : n;
    };
    const lum = (rgb: number[]) =>
      rgb.slice(0, 3).reduce((total, v, i) => {
        const c = v / 255;
        return (
          total +
          (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
            ([0.2126, 0.7152, 0.0722][i] ?? 0)
        );
      }, 0);
    const out: string[] = [];
    for (const el of root.querySelectorAll("*")) {
      const hasText = [...el.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim(),
      );
      if (!hasText || el.closest("script,style,noscript")) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (el instanceof HTMLButtonElement && el.disabled) continue;
      if (el.closest("[aria-hidden='true']")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const fg = parse(style.color);
      // Composite translucent backgrounds over the first opaque ancestor
      // (white when there is none, which is also the worst case for a dark
      // overlay sitting on a photo).
      const layers: number[][] = [];
      let bg = [255, 255, 255];
      for (let p: Element | null = el; p; p = p.parentElement) {
        const c = parse(getComputedStyle(p).backgroundColor);
        if (c.length === 3 || c[3] === 1) {
          bg = c;
          break;
        }
        if (c.length === 4 && (c[3] ?? 0) > 0) layers.push(c);
      }
      for (const c of layers.reverse()) {
        const a = c[3] ?? 1;
        bg = bg.map((v, i) => (c[i] ?? 0) * a + v * (1 - a));
      }
      const ratio =
        (Math.max(lum(fg), lum(bg)) + 0.05) /
        (Math.min(lum(fg), lum(bg)) + 0.05);
      const px = Number.parseFloat(style.fontSize);
      const large =
        px >= 24 || (px >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5))
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" ${ratio.toFixed(2)}`,
        );
    }
    return out;
  });
  return found.map((f) => `${label}: ${f}`);
}

async function visit(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("main#workspace-main")).toBeVisible();
  // Let the page settle: loading skeletons and fetched data replace text.
  await expect(page.getByText("Loading workspace")).toHaveCount(0, {
    timeout: 20_000,
  });
}

test("text on workspace pages meets WCAG contrast (empty states)", async ({
  page,
}) => {
  await mock(page, emptySnapshot, { approvedHours: 0 });
  const failures: string[] = [];
  for (const path of routes) {
    await visit(page, path);
    failures.push(...(await audit(page, `${path} (empty)`)));
  }
  expect(failures).toEqual([]);
});

test("text on workspace pages meets WCAG contrast (populated)", async ({
  page,
}) => {
  await mock(page, populatedSnapshot, report);
  const failures: string[] = [];
  for (const path of routes) {
    await visit(page, path);
    // Guard against auditing an empty page by accident.
    if (path === "/workspace/inbox")
      await expect(
        page.getByRole("button", { name: "Source source-1 · revision 2" }),
      ).toBeVisible();
    if (path === "/workspace/needs")
      await expect(page.getByText("Deliver supplies").first()).toBeVisible();
    failures.push(...(await audit(page, `${path} (populated)`)));
  }
  expect(failures).toEqual([]);
});

test("text meets WCAG contrast in interactive states", async ({ page }) => {
  test.setTimeout(120_000);
  await mock(page, populatedSnapshot, report);
  const failures: string[] = [];

  await visit(page, "/workspace/inbox");
  await page
    .getByRole("button", { name: "Source source-1 · revision 2" })
    .click();
  await expect(page.getByLabel("Review reason")).toBeVisible();
  failures.push(...(await audit(page, "inbox detail open")));
  await page.getByRole("button", { name: "Accept proposal" }).hover();
  failures.push(...(await audit(page, "inbox accept hovered")));
  await page.getByLabel("Review reason").focus();
  failures.push(...(await audit(page, "inbox reason focused")));

  await visit(page, "/workspace");
  await page.keyboard.press("Control+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  failures.push(...(await audit(page, "command palette open")));
  await page.keyboard.press("Escape");

  await page.goto("/dev/foundation");
  const select = page.getByRole("combobox").first();
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  failures.push(...(await audit(page, "foundation select open")));
  await page.keyboard.press("Escape");

  for (const path of ["/workspace", "/workspace/reports"]) {
    await visit(page, path);
    const links = page.locator("main#workspace-main").getByRole("link");
    for (let i = 0; i < (await links.count()); i++) {
      const link = links.nth(i);
      if (await link.isVisible()) await link.hover({ timeout: 2000 });
    }
    failures.push(...(await audit(page, `${path} links hovered`)));
  }
  expect(failures).toEqual([]);
});
