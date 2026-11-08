import { expect, test } from "@playwright/test";

const organization = {
  organizationId: "org",
  name: "Community",
  slug: "community",
  role: "owner",
  membershipId: "m1",
};
const workspace = {
  organization,
  members: [{ membershipId: "m1", name: "Alex" }],
  sources: [],
  queue: [],
  contributions: [],
  needs: [],
  summary: null,
};
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
  await page.route("**/api/product/members", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: [
          {
            membershipId: "m1",
            name: "Alex",
            email: "alex@example.invalid",
            role: "owner",
          },
        ],
      },
    }),
  );
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: workspace } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
});
test("owner updates revisioned settings and retries the same key", async ({
  page,
}) => {
  await page.route("**/api/product/settings", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { ok: true, value: settings } });
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) return route.abort();
    return route.fulfill({
      json: { ok: true, value: { ...settings, revision: 3 } },
    });
  });
  const bodies: Record<string, unknown>[] = [];
  await page.goto("/workspace/settings");
  await page.getByLabel("Timezone").fill("Europe/London");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(
    page.getByText("The service is unavailable. Please try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    expectedRevision: 2,
    timezone: "Europe/London",
    idempotencyKey: expect.any(String),
  });
});
test("notification actions use the frozen payloads", async ({ page }) => {
  await page.route("**/api/product/notifications", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: [
          {
            id: "n1",
            revision: 2,
            type: "need-assigned",
            needId: "need1",
            title: "A need",
            appPath: "/workspace/needs",
            createdAt: "2026-01-01T00:00:00Z",
            readAt: null,
          },
        ],
      },
    }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/notification-read", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, value: {} } });
  });
  await page.goto("/workspace/notifications");
  await page.getByRole("button", { name: "Mark read" }).click();
  await expect.poll(() => body.notificationId).toBe("n1");
  expect(body).toMatchObject({
    notificationId: "n1",
    expectedRevision: 2,
    idempotencyKey: expect.any(String),
  });
});
test("only owners can open member administration", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...workspace,
          organization: { ...organization, role: "coordinator" },
        },
      },
    }),
  );
  await page.goto("/workspace/members");
  await expect(
    page.getByRole("heading", { name: "Permission denied" }),
  ).toBeVisible();
});

test("member roster keeps roles visible and sends the selected invite role", async ({
  page,
}) => {
  await page.route("**/api/product/members", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: [
          {
            membershipId: "m1",
            name: "Alex Rivera",
            email: "alex@example.org",
            role: "owner",
          },
          {
            membershipId: "m2",
            name: "Sam Lee",
            email: "sam@example.org",
            role: "volunteer",
          },
        ],
      },
    }),
  );
  let inviteBody: Record<string, unknown> = {};
  await page.route("**/api/product/members/invite", (route) => {
    inviteBody = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, value: {} } });
  });
  await page.goto("/workspace/members");
  await expect(page.getByText("2 members")).toBeVisible();
  await expect(page.getByText("Alex Rivera", { exact: true })).toBeVisible();
  await expect(
    page.locator("span[class*='roleBadge']").filter({ hasText: /^Owner$/ }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill("new@example.org");
  await page.getByLabel("Workspace role").selectOption("coordinator");
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect.poll(() => inviteBody.email).toBe("new@example.org");
  expect(inviteBody).toEqual({ email: "new@example.org", role: "coordinator" });
});

test("staff must deliberately select and explain a candidate link", async ({
  page,
}) => {
  const entry = {
    source: {
      sourceId: "s1",
      revision: 1,
      text: "Helped",
      channel: "web",
      receivedAt: "2026-01-01T00:00:00Z",
    },
    revision: 2,
    proposal: {
      runId: "r1",
      items: [
        {
          kind: "activity",
          key: "a1",
          activityKind: "visit",
          localDate: null,
          datePrecision: "unknown",
          beneficiaryReference: null,
          evidence: [
            {
              kind: "text",
              field: "activityKind",
              quote: "Helped",
              sourceRevision: 1,
            },
          ],
        },
      ],
      unresolved: [],
    },
  };
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: { ok: true, value: { ...workspace, queue: [entry] } },
    }),
  );
  await page.route("**/api/product/candidates?*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: [
          { activityId: "existing", revision: 4, reason: "Similar date" },
        ],
      },
    }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/review", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, value: { revision: 3 } } });
  });
  await page.goto("/workspace/inbox");
  await page.getByRole("button", { name: "Source s1 · revision 1" }).click();
  const select = page.getByLabel("Link existing activity for a1");
  await expect(select).toHaveValue("");
  await select.selectOption("existing");
  await expect(
    page.getByRole("button", { name: "Accept proposal" }),
  ).toBeDisabled();
  await page
    .getByLabel("Review reason", { exact: false })
    .fill("Confirmed same visit");
  await page.getByRole("button", { name: "Accept proposal" }).click();
  await expect.poll(() => body.runId).toBe("r1");
  expect(body).toMatchObject({
    reason: "Confirmed same visit",
    activityLinks: { a1: { activityId: "existing", expectedRevision: 4 } },
  });
});

test("changing Telegram preserves saved email preference", async ({ page }) => {
  await page.route("**/api/product/notifications", (route) =>
    route.fulfill({ json: { ok: true, value: [] } }),
  );
  let saved = { email: true, telegram: false };
  let submitted: typeof saved | null = null;
  await page.route("**/api/product/notification-preferences", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { ok: true, value: saved } });
    submitted = route.request().postDataJSON();
    saved = submitted as typeof saved;
    return route.fulfill({ json: { ok: true, value: saved } });
  });
  await page.goto("/workspace/notifications");
  await expect(page.getByLabel("Email", { exact: true })).toBeChecked();
  await page.getByLabel("Telegram", { exact: true }).check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect.poll(() => submitted).toEqual({ email: true, telegram: true });
  await expect(page.getByLabel("Email", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Telegram", { exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByLabel("Email", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Telegram", { exact: true })).toBeChecked();
});
