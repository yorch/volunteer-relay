import { expect, test } from "@playwright/test";

const organization = {
  organizationId: "org",
  name: "Community",
  slug: "community",
  role: "owner",
  membershipId: "m1",
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
test.beforeEach(async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
});
test("audit renders actor and untrusted text safely", async ({ page }) => {
  let query = "";
  await page.route("**/api/product/audit?*", (route) => {
    query = route.request().url();
    return route.fulfill({
      json: {
        ok: true,
        value: {
          entries: [
            {
              aggregateType: "need",
              aggregateId: "n1",
              revision: 2,
              action: "changed",
              occurredAt: "2026-01-01T00:00:00Z",
              actor: { kind: "user", membershipId: "m1" },
              reason: "<img src=x onerror=alert(1)>",
              before: { status: "new" },
              after: { status: "assigned" },
            },
          ],
        },
      },
    });
  });
  await page.goto("/workspace/history");
  await page.getByLabel("Record ID").fill("n1");
  await page.getByRole("button", { name: "Find history" }).click();
  await expect(page.getByText("Team member", { exact: false })).toBeVisible();
  await expect(page.getByText("Changed", { exact: true })).toBeVisible();
  await expect(
    page.getByText("<img src=x onerror=alert(1)>", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.getByText('"assigned"', { exact: false })).toBeHidden();
  await page.getByText("Technical record details").click();
  await expect(page.getByText('"assigned"', { exact: false })).toBeVisible();
  expect(new URL(query).searchParams.get("aggregateId")).toBe("n1");
});
test("delivery distinguishes failed from provider acceptance", async ({
  page,
}) => {
  await page.route("**/api/product/deliveries", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: [
          {
            id: "d1",
            needId: "n1",
            recipientId: "m1",
            channel: "email",
            template: "need",
            attempts: 2,
            acceptedAt: null,
            retryAfter: null,
            status: "failed",
          },
          {
            id: "d2",
            needId: "n1",
            recipientId: "m2",
            channel: "telegram",
            template: "need",
            attempts: 1,
            acceptedAt: "2026-01-01T00:00:00Z",
            retryAfter: null,
            status: "accepted",
          },
        ],
      },
    }),
  );
  await page.route("**/api/product/operations", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          queuedSources: 1,
          failedSources: 2,
          oldestQueuedAt: null,
          unresolvedUrgentNeeds: 1,
          overdueAcknowledgments: 1,
          failedDeliveries: 1,
          modelReservedMicroUsd: 500000,
          modelSettledMicroUsd: 250000,
          availableStorageBytes: null,
        },
      },
    }),
  );
  await page.goto("/workspace/delivery");
  await expect(page.getByRole("table", { name: "Deliveries" })).toBeVisible();
  await expect(page.getByText("failed", { exact: true })).toBeVisible();
  await expect(page.getByText("accepted", { exact: true })).toBeVisible();
  await expect(
    page.getByText("does not confirm that a person received or acknowledged", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("n1", { exact: true })).toBeHidden();
  await page.getByText("View", { exact: true }).first().click();
  await expect(page.getByText("n1", { exact: true }).first()).toBeVisible();
});
test("report reader cannot access history or delivery", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "report-reader" },
        },
      },
    }),
  );
  await page.goto("/workspace/history");
  await expect(
    page.getByRole("heading", { name: "Permission denied" }),
  ).toBeVisible();
  await page.goto("/workspace/delivery");
  await expect(
    page.getByRole("heading", { name: "Permission denied" }),
  ).toBeVisible();
});

test("coordinator sees deliveries without requesting owner operations", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
        },
      },
    }),
  );
  await page.route("**/api/product/deliveries", (route) =>
    route.fulfill({ json: { ok: true, value: [] } }),
  );
  let operationsRequested = false;
  await page.route("**/api/product/operations", (route) => {
    operationsRequested = true;
    return route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    });
  });
  await page.goto("/workspace/delivery");
  await expect(page.getByText("No deliveries yet")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Organization operations" }),
  ).toHaveCount(0);
  expect(operationsRequested).toBe(false);
});
