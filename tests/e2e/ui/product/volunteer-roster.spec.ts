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

async function open(
  page: Page,
  role: string,
  report: object,
  options: { members?: object[]; search?: string } = {},
) {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          members: options.members ?? snapshot.members,
          organization: { ...organization, role },
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports*", (route) =>
    route.fulfill({ json: { ok: true, value: report } }),
  );
  await page.goto(`/workspace/reports${options.search ?? ""}`);
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

// Thirty-two synthetic members: thirty numbered ones plus two names with
// diacritics, each with a distinct approved total (in minutes).
const crowdMembers = [
  ...Array.from({ length: 30 }, (_, i) => ({
    membershipId: `crowd-${String(i + 1).padStart(2, "0")}`,
    name: `Volunteer ${String(i + 1).padStart(2, "0")}`,
  })),
  { membershipId: "crowd-jose", name: "José Núñez" },
  { membershipId: "crowd-zoe", name: "Zoë Ångström" },
];
const crowdReport = {
  ...baseReport,
  volunteers: crowdMembers.map((m, i) => ({
    membershipId: m.membershipId,
    approvedMinutes: (i + 1) * 30,
    weekApprovedMinutes: 0,
    approvedContributions: 1,
    pendingContributions: 0,
    pendingUnknownDuration: 0,
  })),
  volunteersTruncated: false,
};
const rosterTable = (page: Page) =>
  page.getByRole("table", { name: /for each volunteer/ });
const bodyRows = (page: Page) =>
  rosterTable(page).locator("tbody tr").filter({ visible: true });
const noHorizontalScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );

test("searching matches names without case or accents, resets the page and survives a reload", async ({
  page,
}) => {
  await open(page, "coordinator", crowdReport, {
    members: crowdMembers,
    search: "?vpage=2",
  });
  await expect(page.getByText("Showing 26–32 of 32")).toBeVisible();
  const search = page.getByLabel("Search volunteers");
  await search.fill("JOSE nunez");
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(
    rosterTable(page).getByRole("rowheader", { name: "José Núñez" }),
  ).toBeVisible();
  await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
  await expect(page.getByText(/^1 volunteer match\./)).toBeAttached();
  expect(new URL(page.url()).searchParams.get("vq")).toBe("JOSE nunez");
  expect(new URL(page.url()).searchParams.has("vpage")).toBe(false);
  await page.reload();
  await expect(page.getByLabel("Search volunteers")).toHaveValue("JOSE nunez");
  await expect(bodyRows(page)).toHaveCount(1);
  await page.getByLabel("Search volunteers").fill("zzz");
  await expect(page.getByText("No volunteers match “zzz”.")).toBeVisible();
});

test("sortable headers expose aria-sort and keep the order in the URL", async ({
  page,
}) => {
  test.skip(
    (page.viewportSize()?.width ?? 0) <= 760,
    "Narrow screens sort with the Sort by control instead of the hidden header row",
  );
  await open(page, "coordinator", crowdReport, { members: crowdMembers });
  const header = (name: string) =>
    rosterTable(page).getByRole("columnheader", { name });
  // Default: approved hours, highest first.
  await expect(header("Approved hours")).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(bodyRows(page).first()).toContainText("Zoë Ångström");
  await header("Volunteer").getByRole("button").click();
  await expect(header("Volunteer")).toHaveAttribute("aria-sort", "ascending");
  await expect(header("Approved hours")).toHaveAttribute("aria-sort", "none");
  await expect(bodyRows(page).first()).toContainText("José Núñez");
  expect(new URL(page.url()).searchParams.get("vsort")).toBe("name-asc");
  await header("Volunteer").getByRole("button").click();
  await expect(header("Volunteer")).toHaveAttribute("aria-sort", "descending");
  await expect(bodyRows(page).first()).toContainText("Zoë Ångström");
  await header("Approved hours").getByRole("button").click();
  await expect(bodyRows(page).first()).toContainText("Zoë Ångström");
  await header("Approved hours").getByRole("button").click();
  await expect(bodyRows(page).first()).toContainText("Volunteer 01");
  expect(new URL(page.url()).searchParams.get("vsort")).toBe("approved-asc");
});

test("pages 25 volunteers at a time and reads the page from the URL", async ({
  page,
}) => {
  await open(page, "coordinator", crowdReport, {
    members: crowdMembers,
    search: "?vsort=name-asc",
  });
  await expect(page.getByText("Showing 1–25 of 32")).toBeVisible();
  await expect(bodyRows(page)).toHaveCount(25);
  const previous = page.getByRole("button", { name: "Previous page" });
  const next = page.getByRole("button", { name: "Next page" });
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(page.getByText("Showing 26–32 of 32")).toBeVisible();
  await expect(bodyRows(page)).toHaveCount(7);
  await expect(next).toBeDisabled();
  expect(new URL(page.url()).searchParams.get("vpage")).toBe("2");
  expect(new URL(page.url()).searchParams.get("vsort")).toBe("name-asc");
  await previous.click();
  await expect(page.getByText("Showing 1–25 of 32")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("invalid roster URL values fall back to the defaults", async ({
  page,
}) => {
  await open(page, "coordinator", crowdReport, {
    members: crowdMembers,
    search: "?vsort=salary-up&vpage=-3&vq=",
  });
  await expect(page.getByText("Showing 1–25 of 32")).toBeVisible();
  await expect(
    rosterTable(page).getByRole("columnheader", { name: "Approved hours" }),
  ).toHaveAttribute("aria-sort", "descending");
  await expect(page.getByLabel("Search volunteers")).toHaveValue("");
  // A page past the end is clamped to the last page.
  await page.goto("/workspace/reports?vpage=40");
  await expect(page.getByText("Showing 26–32 of 32")).toBeVisible();
});

test("staff can list members with no contributions as known zeros", async ({
  page,
}) => {
  const members = [
    ...snapshot.members,
    { membershipId: "member-3", name: "Cleo" },
  ];
  await open(
    page,
    "coordinator",
    { ...staffReport, query: {}, volunteersTruncated: false },
    {
      members,
    },
  );
  await expect(
    rosterTable(page).getByRole("rowheader", { name: /Cleo/ }),
  ).toHaveCount(0);
  await page.getByLabel("Show members with no contributions").check();
  const cleo = rosterTable(page).getByRole("row", { name: /Cleo/ });
  await expect(cleo.getByText("No contributions yet").first()).toBeVisible();
  await expect(cleo.getByText("0 h", { exact: true })).toHaveCount(2);
  await expect(cleo.getByRole("link")).toHaveCount(0);
  await expect(bodyRows(page)).toHaveCount(4);
});

test("a truncated roster does not offer members with no contributions", async ({
  page,
}) => {
  await open(page, "coordinator", staffReport);
  await expect(
    page.getByLabel("Show members with no contributions"),
  ).toHaveCount(0);
});

const detailReport = {
  ...baseReport,
  query: { from: "2026-11-01", to: "2026-11-30", membershipId: "member-1" },
  volunteers: [staffReport.volunteers[0]],
  volunteersTruncated: false,
  volunteerDetail: {
    membershipId: "member-1",
    weeks: [
      ["2026-09-14", 0],
      ["2026-09-21", 60],
      ["2026-09-28", 0],
      ["2026-10-05", 90],
      ["2026-10-12", 0],
      ["2026-10-19", 30],
      ["2026-10-26", 0],
      ["2026-11-02", 45],
    ].map(([weekStart, approvedMinutes]) => ({ weekStart, approvedMinutes })),
    unknownDateContributions: 1,
    byActivity: [
      {
        activityId: "activity-garden",
        kind: "Garden",
        localDate: "2026-11-03",
        approvedMinutes: 90,
        approvedContributions: 1,
      },
      {
        activityId: "activity-undated",
        kind: "Kitchen shift",
        localDate: null,
        approvedMinutes: 45,
        approvedContributions: 2,
      },
    ],
    byActivityTruncated: false,
  },
};

test("a volunteer filter shows the weekly chart, its data table and approved time by activity", async ({
  page,
}) => {
  await open(page, "coordinator", detailReport);
  const panel = page.getByRole("region", { name: "Alex" });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("heading", { name: "Approved hours, last 8 weeks" }),
  ).toBeVisible();
  const weeks = panel.getByRole("table", { name: /per week for Alex/ });
  await expect(weeks.getByRole("row")).toHaveCount(9);
  await expect(
    weeks.getByRole("row", { name: /2026-11-02 \(this week\)/ }),
  ).toContainText("0.8 h");
  await expect(weeks.getByRole("row", { name: /2026-09-14/ })).toContainText(
    "0 h",
  );
  await expect(
    panel.getByText(/1 approved contribution has an unknown date/),
  ).toBeVisible();
  const activities = panel.getByRole("table", { name: /by activity for Alex/ });
  await expect(activities.getByRole("row")).toHaveCount(3);
  await expect(
    activities
      .getByRole("row", { name: /Kitchen shift/ })
      .getByText("Date unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "View in ledger for Garden, 2026-11-03" }),
  ).toHaveAttribute(
    "href",
    "/workspace/activities?status=approved&membership=member-1&from=2026-11-03&to=2026-11-03",
  );
  await expect(
    panel.getByRole("link", {
      name: "View in ledger for Kitchen shift, Date unknown",
    }),
  ).toHaveAttribute(
    "href",
    "/workspace/activities?status=approved&membership=member-1",
  );
  // One volunteer in scope: no "members with no contributions" toggle.
  await expect(
    page.getByLabel("Show members with no contributions"),
  ).toHaveCount(0);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("the detail panel and a long roster fit a 320px screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await open(page, "coordinator", detailReport);
  await expect(page.getByRole("region", { name: "Alex" })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(page, "coordinator", crowdReport, { members: crowdMembers });
  await expect(page.getByText("Showing 1–25 of 32")).toBeVisible();
  await expect(page.getByLabel("Sort by")).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test("staff get a volunteer CSV link for the same filters", async ({
  page,
}) => {
  await open(page, "coordinator", staffReport);
  await expect(
    page.getByRole("link", { name: "Download volunteer CSV" }),
  ).toHaveAttribute("href", "/api/product/reports.csv?view=volunteers");
  await expect(
    page.getByRole("link", { name: "Download aggregate CSV" }),
  ).toHaveAttribute("href", "/api/product/reports.csv");
});

test("a report reader gets no detail panel, roster controls or volunteer CSV", async ({
  page,
}) => {
  const { topContributors: _, ...aggregate } = baseReport;
  await open(page, "report-reader", {
    ...aggregate,
    query: { membershipId: "member-1" },
  });
  await expect(page.getByRole("region", { name: "Alex" })).toHaveCount(0);
  await expect(page.getByLabel("Search volunteers")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Download volunteer CSV" }),
  ).toHaveCount(0);
});
