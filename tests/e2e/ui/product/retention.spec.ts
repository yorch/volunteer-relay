import { expect, test } from "@playwright/test";

const snapshot = {
  organization: {
    organizationId: "org",
    name: "Community",
    slug: "community",
    role: "owner",
    membershipId: "m1",
  },
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
test("redaction requires reason and explicit acknowledgment", async ({
  page,
}) => {
  await page.route("**/api/product/retention-preview", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          cutoff: "2026-01-01T00:00:00Z",
          truncated: false,
          sources: [
            {
              sourceId: "s1",
              latestRevision: 4,
              expiredRevisions: 2,
              attachmentCount: 1,
            },
          ],
        },
      },
    }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/retention-redact", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, value: { redactionId: "r1" } } });
  });
  await page.goto("/workspace/retention");
  await expect(
    page.getByRole("link", { name: "Download signed retention ledger" }),
  ).toHaveAttribute("href", "/api/product/retention-ledger");
  await page.getByRole("button", { name: "Review redaction" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm redaction" }),
  ).toBeDisabled();
  await page
    .getByLabel("Reason for redaction")
    .fill("Retention period expired");
  await expect(
    page.getByRole("button", { name: "Confirm redaction" }),
  ).toBeDisabled();
  await page.getByLabel("I understand this redaction is irreversible.").check();
  await page.getByRole("button", { name: "Confirm redaction" }).click();
  await expect.poll(() => body.sourceId).toBe("s1");
  expect(body).toMatchObject({
    sourceId: "s1",
    expectedRevision: 4,
    reason: "Retention period expired",
    idempotencyKey: expect.any(String),
  });
});
test("coordinator is denied retention", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...snapshot.organization, role: "coordinator" },
        },
      },
    }),
  );
  await page.goto("/workspace/retention");
  await expect(
    page.getByRole("heading", { name: "Permission denied" }),
  ).toBeVisible();
});
