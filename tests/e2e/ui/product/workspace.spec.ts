import { expect, test } from "@playwright/test";

const organization = {
  organizationId: "org-1",
  name: "Community",
  slug: "community",
  role: "volunteer",
  membershipId: "member-1",
};
const snapshot = {
  organization,
  members: [],
  sources: [],
  queue: [],
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
  ],
  needs: [],
  summary: null,
};

test("volunteer submits text and sees receipt and unknown duration", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: { currentOrganizationId: "org-1", options: [organization] },
      },
    }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/sources", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        value: {
          sourceId: "source-1",
          revision: 1,
          status: "received",
          correlationId: "correlation-1",
        },
      },
    });
  });
  await page.goto("/workspace/volunteer");
  await expect(page.getByText("Unknown duration")).toBeVisible();
  await page.getByLabel("Your update").fill("Helped at the garden");
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(
    page.getByText("Receipt: source-1", { exact: false }),
  ).toBeVisible();
  expect(body).toMatchObject({
    schemaVersion: 1,
    text: "Helped at the garden",
  });
  expect(body.idempotencyKey).toEqual(expect.any(String));
  expect(body).not.toHaveProperty("organizationId");
});

test("report reader sees only summary and is denied inbox", async ({
  page,
}) => {
  const reader = {
    ...snapshot,
    organization: { ...organization, role: "report-reader" },
    contributions: [],
    summary: {
      approvedMinutes: 90,
      approvedContributions: 1,
      activitiesWithApprovedContributions: 1,
      pendingContributions: 1,
      pendingUnknownDuration: 1,
      pendingUnresolvedVolunteer: 0,
    },
  };
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: reader } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } },
    }),
  );
  await page.goto("/workspace/reports");
  await expect(page.getByText("Approved minutes")).toBeVisible();
  await expect(page.getByText("90", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Source inbox" })).toHaveCount(0);
  await page.goto("/workspace/inbox");
  await expect(
    page.getByRole("heading", { name: "Permission denied" }),
  ).toBeVisible();
});

test("staff reviews preserved source with optimistic revision", async ({
  page,
}) => {
  const entry = {
    source: {
      sourceId: "source-1",
      revision: 2,
      text: "Helped for 90 minutes",
      channel: "web",
      receivedAt: "2026-01-01T00:00:00Z",
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
              sourceRevision: 2,
            },
          ],
        },
      ],
      unresolved: [{ field: "membershipId", reason: "Unknown volunteer" }],
    },
  };
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          queue: [entry],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/review", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, value: { revision: 4 } } });
  });
  await page.goto("/workspace/inbox");
  await expect(page.getByText("Helped for 90 minutes")).toBeVisible();
  await expect(
    page.getByText("durationMinutes: “90 minutes”", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("membershipId: Unknown volunteer")).toBeVisible();
  await page.getByLabel("Review reason").fill("Confirmed with team");
  await page.getByRole("button", { name: "Accept proposal" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  expect(body).toMatchObject({
    runId: "run-1",
    expectedRevision: 3,
    decision: "accept",
    reason: "Confirmed with team",
  });
  expect(body).not.toHaveProperty("organizationId");
});
