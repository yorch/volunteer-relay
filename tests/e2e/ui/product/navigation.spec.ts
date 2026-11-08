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
  needs: [],
  summary: null,
};

test("moving between workspace pages keeps the loaded workspace and shows no loading screen", async ({
  page,
}) => {
  let snapshotRequests = 0;
  await page.route("**/api/product/workspace", (route) => {
    snapshotRequests += 1;
    return route.fulfill({ json: { ok: true, value: snapshot } });
  });
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({ json: { ok: true, value: { approvedHours: 3 } } }),
  );
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  // A full document load would drop this marker.
  await page.evaluate(() => {
    (window as unknown as { kept: boolean }).kept = true;
  });
  const openMenu = async () => {
    const menu = page.getByText("Menu", { exact: true });
    if (await menu.isVisible()) await menu.click();
  };
  const loading = page.getByText("Loading workspace…");

  await openMenu();
  await page
    .getByRole("navigation", { name: "Workspace" })
    .getByRole("link", { name: "Needs", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workspace\/needs$/);
  await expect(page.locator("#workspace-main")).toBeFocused();
  await expect(loading).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(loading).toHaveCount(0);

  expect(
    await page.evaluate(() => (window as unknown as { kept?: boolean }).kept),
  ).toBe(true);
  expect(snapshotRequests).toBe(1);
});

test("first load shows a shell-shaped skeleton with one announced status", async ({
  page,
}, testInfo) => {
  await page.route("**/api/product/workspace", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ json: { ok: true, value: snapshot } });
  });
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({ json: { ok: true, value: { approvedHours: 3 } } }),
  );
  await page.goto("/workspace");
  const loading = page.getByText("Loading workspace…");
  await expect(loading).toBeVisible();
  // The brand and main landmark are already in place, so the layout does not
  // jump when the real shell arrives.
  await expect(
    page.getByRole("link", { name: "volunteer relay." }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("loading-skeleton.png"),
    fullPage: true,
  });
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(loading).toHaveCount(0);
});
