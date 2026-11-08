import { expect, test } from "@playwright/test";
import { chooseOption, expectOption } from "../helpers/controls.js";

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

test("category routing chooses eligible people by name", async ({ page }) => {
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
  await page.getByLabel("Category", { exact: true }).fill("transport");
  await page.getByRole("checkbox", { name: "Jordan", exact: true }).check();
  await expect(
    page.getByRole("checkbox", { name: "Sam", exact: true }),
  ).toHaveCount(0);
  await chooseOption(
    page.getByLabel("Fallback member", { exact: false }),
    "owner",
  );
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => body).not.toBeNull();
  expect(body).toMatchObject({
    expectedRevision: 2,
    routing: { transport: ["staff"] },
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

test("unavailable fallback requires an explicit replacement or removal", async ({
  page,
}) => {
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/product/settings", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          ok: true,
          value: { ...settings, fallbackMembershipId: "former-staff" },
        },
      });
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, value: settings } });
  });
  await page.goto("/workspace/settings");
  const fallback = page.getByLabel("Fallback member", { exact: false });
  await expect(fallback).toBeEnabled();
  await expectOption(fallback, "former-staff");
  await page
    .getByLabel("Organization timezone", { exact: false })
    .fill("Europe/London");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText(
      "Choose an available fallback member or explicitly select No fallback member.",
    ),
  ).toBeVisible();
  expect(body).toBeNull();
  await chooseOption(fallback, "");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => body).not.toBeNull();
  expect(body).toMatchObject({
    fallbackMembershipId: null,
    timezone: "Europe/London",
  });
});

test("valid fallback survives delayed team loading and an unrelated edit", async ({
  page,
}) => {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/product/members", async (route) => {
    await ready;
    return route.fulfill({ json: { ok: true, value: members } });
  });
  let body: Record<string, unknown> | null = null;
  await page.route("**/api/product/settings", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          ok: true,
          value: { ...settings, fallbackMembershipId: "staff" },
        },
      });
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, value: settings } });
  });
  await page.goto("/workspace/settings");
  const fallback = page.getByLabel("Fallback member", { exact: false });
  await expect(fallback).toBeDisabled();
  await expectOption(fallback, "staff");
  release();
  await expect(fallback).toBeEnabled();
  await expectOption(fallback, "staff");
  await page
    .getByLabel("Organization timezone", { exact: false })
    .fill("Europe/London");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => body).not.toBeNull();
  expect(body).toMatchObject({
    fallbackMembershipId: "staff",
    timezone: "Europe/London",
  });
});

test("reserved routing category is rejected before saving", async ({
  page,
}) => {
  let saves = 0;
  await page.route("**/api/product/settings", (route) => {
    if (route.request().method() === "POST") saves++;
    return route.fulfill({ json: { ok: true, value: settings } });
  });
  await page.goto("/workspace/settings");
  await page.getByRole("button", { name: "Add category route" }).click();
  await page.getByLabel("Category", { exact: true }).fill("__proto__");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("Choose a different category name; this name is reserved."),
  ).toBeVisible();
  expect(saves).toBe(0);
});
