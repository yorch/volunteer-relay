import { expect, type Page, test } from "@playwright/test";

// Synthetic organization, members and minutes only.
const organization = {
  organizationId: "org-1",
  name: "Community",
  slug: "community",
  role: "coordinator",
  membershipId: "member-1",
};
const snapshot = {
  organization,
  members: [
    { membershipId: "member-1", name: "Alex" },
    { membershipId: "member-2", name: "Bea" },
  ],
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
  pendingUnresolvedVolunteer: 0,
};
const baseReport = {
  query: { from: "2026-11-01", to: "2026-11-30" },
  timezone: "UTC",
  ledger,
  approvedHours: 2.25,
  openNeeds: 0,
  resolvedNeeds: 0,
  averageAcknowledgmentMinutes: null,
  excludedUnknownDate: 0,
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
};
const staffReport = {
  ...baseReport,
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
    {
      membershipId: "member-gone",
      approvedMinutes: 0,
      weekApprovedMinutes: 0,
      approvedContributions: 0,
      pendingContributions: 1,
      pendingUnknownDuration: 1,
    },
  ],
  volunteersTruncated: true,
};

async function open(page: Page, role: string, report: object) {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: { ...snapshot, organization: { ...organization, role } },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports*", (route) =>
    route.fulfill({ json: { ok: true, value: report } }),
  );
  await page.goto("/workspace/reports");
  await expect(page.getByText("Approved minutes")).toBeVisible();
}

test("staff see every volunteer's hours with links to their contributions", async ({
  page,
}) => {
  await open(page, "coordinator", staffReport);
  const roster = page.getByRole("table", { name: /for each volunteer/ });
  await expect(
    page.getByRole("heading", { name: "Volunteers", exact: true }),
  ).toBeVisible();
  await expect(roster.getByRole("row")).toHaveCount(4);
  const alex = roster.getByRole("row", { name: /Alex/ });
  await expect(alex.getByText("2.3 h", { exact: true })).toBeVisible();
  await expect(alex.getByText("0.8 h", { exact: true })).toBeVisible();
  // A known zero is shown as zero hours, not as unknown.
  const bea = roster.getByRole("row", { name: /Bea/ });
  await expect(bea.getByText("0 h", { exact: true })).toHaveCount(2);
  await expect(bea.getByText("1 unknown duration")).toBeVisible();
  await expect(roster.getByText("Unknown", { exact: true })).toHaveCount(0);
  await expect(
    roster.getByRole("rowheader", { name: "Former member" }),
  ).toBeVisible();
  await expect(page.getByText("Truncated:")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "View contributions for Alex" }),
  ).toHaveAttribute(
    "href",
    "/workspace/activities?membership=member-1&from=2026-11-01&to=2026-11-30",
  );
  // The roster supersedes the separate top-five list on this page.
  await expect(
    page.getByRole("heading", { name: "Top contributors" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("the roster fits a 320px screen without horizontal scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await open(page, "coordinator", staffReport);
  await expect(
    page.getByRole("link", { name: "View contributions for Bea" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("a report reader gets no roster", async ({ page }) => {
  const { topContributors: _, ...aggregate } = baseReport;
  await open(page, "report-reader", aggregate);
  await expect(
    page.getByRole("heading", { name: "Volunteers", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: /View contributions/ }),
  ).toHaveCount(0);
});
