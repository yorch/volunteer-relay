import { expect, test } from "@playwright/test";

const organization = {
  organizationId: "org",
  membershipId: "owner",
  name: "Community",
  slug: "community",
  role: "owner",
};
const members = [
  {
    membershipId: "owner",
    name: "Alex",
    email: "alex@example.invalid",
    role: "owner",
  },
  {
    membershipId: "staff",
    name: "Jordan",
    email: "jordan@example.invalid",
    role: "coordinator",
  },
  {
    membershipId: "volunteer",
    name: "Sam",
    email: "sam@example.invalid",
    role: "volunteer",
  },
];
const settings = {
  revision: 2,
  timezone: "UTC",
  automationPolicy: "review-all",
  policyVersion: "v1",
  routing: {},
  fallbackMembershipId: null,
  ackMinutes: 60,
  retentionDays: 365,
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          organization,
          members,
          sources: [],
          queue: [],
          contributions: [],
          needs: [],
          summary: null,
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/members", (route) =>
    route.fulfill({ json: { ok: true, value: members } }),
  );
});

test("category routing chooses eligible people and preserves special category keys", async ({
  page,
}) => {
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/product/settings", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { ok: true, value: settings } });
    body = route.request().postDataJSON();
    return route.fulfill({
      json: { ok: true, value: { ...settings, revision: 3 } },
    });
  });
  await page.goto("/workspace/settings");
  await page.getByRole("button", { name: "Add category route" }).click();
  await page.getByLabel("Category", { exact: true }).fill("__proto__");
  await page.getByRole("checkbox", { name: "Jordan", exact: true }).check();
  await expect(
    page.getByRole("checkbox", { name: "Sam", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Fallback member", { exact: false })
    .selectOption("owner");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => body).not.toBeNull();
  expect(body).toMatchObject({
    expectedRevision: 2,
    routing: { ["__proto__"]: ["staff"] },
    fallbackMembershipId: "owner",
  });
});

test("duplicate category routes are blocked before a request", async ({
  page,
}) => {
  let saves = 0;
  await page.route("**/api/product/settings", (route) => {
    if (route.request().method() === "POST") saves++;
    return route.fulfill({ json: { ok: true, value: settings } });
  });
  await page.goto("/workspace/settings");
  await page.getByRole("button", { name: "Add category route" }).click();
  await page.getByRole("button", { name: "Add category route" }).click();
  const fields = page.getByLabel("Category", { exact: true });
  await fields.nth(0).fill("transport");
  await fields.nth(1).fill("transport");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("Give each route a different, nonempty category."),
  ).toBeVisible();
  expect(saves).toBe(0);
});
