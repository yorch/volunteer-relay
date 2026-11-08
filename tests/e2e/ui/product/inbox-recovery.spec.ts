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
  sources: [{ sourceId: "failed-1", revision: 2, status: "failed" }],
  queue: [
    {
      source: {
        sourceId: "source 1",
        revision: 3,
        text: "A synthetic update",
        channel: "web",
        receivedAt: "2026-01-01T00:00:00Z",
        attachments: [
          {
            id: "photo 1",
            storageKey: "private/never-use",
            mimeType: "image/png",
          },
        ],
      },
      revision: 1,
      proposal: { runId: "run-1", items: [], unresolved: [] },
    },
  ],
  contributions: [],
  needs: [],
  summary: null,
};
test("failure retry reuses its key and evidence photo uses authorized route", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/product/retry-source", (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.abort()
      : route.fulfill({ json: { ok: true, value: {} } });
  });
  let imageRequested = false;
  await page.route("**/api/product/attachments/**", (route) => {
    imageRequested = true;
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB0sAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await page.goto("/workspace/inbox");
  await expect(page.getByText("Source failed-1 · revision 2")).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect(
    page.getByText("The service is unavailable. Please try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({
    sourceId: "failed-1",
    idempotencyKey: expect.any(String),
  });
  await page
    .getByRole("button", { name: "Source source 1 · revision 3" })
    .click();
  const image = page.getByRole("img", {
    name: "Source attachment photo 1, revision 3",
  });
  await expect(image).toHaveAttribute(
    "src",
    "/api/product/attachments/source%201/photo%201",
  );
  await expect.poll(() => imageRequested).toBe(true);
});

test("failed update evidence remains inspectable before retry without a proposal", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: { ...snapshot, queue: [] } } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  let queried = "";
  await page.route("**/api/product/source?*", (route) => {
    queried = new URL(route.request().url()).searchParams.get("sourceId") ?? "";
    return route.fulfill({
      json: {
        ok: true,
        value: {
          sourceId: "failed-1",
          revision: 2,
          channel: "web",
          receivedAt: "2026-01-01T00:00:00Z",
          text: "Original volunteer update",
          attachments: [{ id: "photo 1" }],
        },
      },
    });
  });
  await page.route("**/api/product/attachments/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB0sAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/product/retry-source", (route) => {
    bodies.push(route.request().postDataJSON());
    return bodies.length === 1
      ? route.abort()
      : route.fulfill({ json: { ok: true, value: {} } });
  });
  await page.goto("/workspace/inbox");
  await page.getByRole("button", { name: "Inspect evidence" }).click();
  await expect(page.getByText("Original volunteer update")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Source attachment photo 1, revision 2" }),
  ).toHaveAttribute("src", "/api/product/attachments/failed-1/photo%201");
  expect(queried).toBe("failed-1");
  await expect(
    page.getByRole("button", { name: "Accept proposal" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect(
    page.getByText("The service is unavailable. Please try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry processing" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0]).toMatchObject({
    sourceId: "failed-1",
    idempotencyKey: expect.any(String),
  });
});
