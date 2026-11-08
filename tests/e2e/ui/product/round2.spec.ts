import { expect, test } from "@playwright/test";

const organization = {
  organizationId: "org-1",
  name: "Community",
  slug: "community",
  role: "coordinator",
  membershipId: "member-1",
};
const snapshot = {
  organization,
  members: [],
  sources: [],
  queue: [],
  contributions: [],
  needs: [
    {
      needId: "n1",
      summary: "Deliver supplies",
      status: "new",
      urgency: "urgent",
      provisional: false,
      dueAt: null,
    },
  ],
  summary: null,
};
const ledger = {
  approvedMinutes: 180,
  approvedContributions: 2,
  activitiesWithApprovedContributions: 1,
  pendingContributions: 1,
  pendingUnknownDuration: 1,
  pendingUnresolvedVolunteer: 1,
};

async function mockWorkspace(
  page: import("@playwright/test").Page,
  report: unknown,
) {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({ json: { ok: true, value: report } }),
  );
  await page.route("**/api/product/notifications", (route) =>
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

test("command palette finds a need, navigates and returns focus; alerts link shows unread", async ({
  page,
}) => {
  await mockWorkspace(page, { approvedHours: 3, ledger });
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Unread alerts (1)" }),
  ).toBeVisible();
  // Nothing about the palette exists in the DOM while it is closed.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.press("Control+K");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("supplies");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/workspace\/needs$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("command palette closes on Escape and returns focus to its button", async ({
  page,
}) => {
  await mockWorkspace(page, { approvedHours: 3, ledger });
  await page.goto("/workspace");
  const button = page.getByRole("button", { name: "Search workspace" });
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("composition bar lists overlapping pending flags as counts and survives a report without a ledger", async ({
  page,
}) => {
  await mockWorkspace(page, { approvedHours: 3, ledger });
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "Where contributions stand" }),
  ).toBeVisible();
  await expect(page.getByText("Approved: 2")).toBeVisible();
  await expect(page.getByText("Pending: 1", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Pending with duration unknown: 1"),
  ).toBeVisible();
  await expect(
    page.getByText("Pending with volunteer unresolved: 1"),
  ).toBeVisible();
  await expect(page.getByText(/can overlap/)).toBeVisible();

  // A report with no ledger must render the overview, not crash it.
  await page.unroute("**/api/product/reports");
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({ json: { ok: true, value: { approvedHours: 3 } } }),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Where contributions stand" }),
  ).toHaveCount(0);
});
