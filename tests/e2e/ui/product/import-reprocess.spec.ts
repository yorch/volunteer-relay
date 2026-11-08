import { expect, test } from "@playwright/test";

const snapshot = {
  organization: {
    organizationId: "org",
    name: "Community",
    slug: "community",
    role: "coordinator",
    membershipId: "m1",
  },
  members: [],
  sources: [{ sourceId: "s1", revision: 4, status: "accepted" }],
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
test("reprocessing retries unchanged revision with same key", async ({
  page,
}) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/product/reprocess-source", (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.abort()
      : route.fulfill({ json: { ok: true, value: { generation: 2 } } });
  });
  await page.goto("/workspace/inbox");
  await page.getByText("Processing and reprocessing").click();
  await page
    .getByRole("button", { name: "Reprocess with current model and policy" })
    .click();
  await expect(
    page.getByText("The service is unavailable. Please try again."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Reprocess with current model and policy" })
    .click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({
    sourceId: "s1",
    expectedRevision: 4,
    idempotencyKey: expect.any(String),
  });
});
test("text and mapped photo are previewed and confirmed as multipart", async ({
  page,
}) => {
  const bodies: string[] = [];
  await page.route("**/api/product/import-preview", (route) => {
    bodies.push(route.request().postData() ?? "");
    return route.fulfill({
      json: {
        ok: true,
        value: {
          sources: [
            {
              sourceId: "s1",
              revision: 1,
              author: { externalIdentity: "Alex" },
              text: "Helped",
              attachments: [{ id: "p1" }],
            },
          ],
          errors: [],
          ambiguousDuplicates: [],
        },
      },
    });
  });
  await page.route("**/api/product/import", (route) => {
    bodies.push(route.request().postData() ?? "");
    return route.fulfill({
      json: {
        ok: true,
        value: {
          receipts: [
            {
              sourceId: "s1",
              revision: 1,
              status: "received",
              correlationId: "c1",
            },
          ],
        },
      },
    });
  });
  await page.goto("/workspace/import");
  await page.getByLabel("Text file", { exact: false }).setInputFiles({
    name: "updates.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("id,author,text,timestamp\n1,Alex,Helped,2026-01-01"),
  });
  await expect(page.getByLabel("Import text")).toContainText("Alex");
  await page.getByLabel("Photos", { exact: false }).setInputFiles({
    name: "garden,front.png",
    mimeType: "image/png",
    buffer: Buffer.from("synthetic"),
  });
  await page.getByRole("button", { name: "Add photo link" }).click();
  await page.getByLabel("Update ID").fill("1");
  await page
    .getByLabel("Photo", { exact: true })
    .selectOption("garden,front.png");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText("1 attachments", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("1 updates received.")).toBeVisible();
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body).toContain('name="data"');
    expect(body).toContain('name="files"; filename="garden,front.png"');
    expect(body).toContain('"photoMapping":{"1":["garden,front.png"]}');
  }
  expect(bodies[1]).toContain('"idempotencyKey"');
});
