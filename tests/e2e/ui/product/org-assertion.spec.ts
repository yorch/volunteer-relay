import { expect, type Page, test } from "@playwright/test";

const orgs = {
  "org-1": {
    organizationId: "org-1",
    name: "Community",
    slug: "community",
    role: "volunteer",
    membershipId: "member-1",
  },
  "org-2": {
    organizationId: "org-2",
    name: "Second Org",
    slug: "second",
    role: "volunteer",
    membershipId: "member-2",
  },
} as const;
const snapshotFor = (id: keyof typeof orgs) => ({
  organization: orgs[id],
  members: [],
  sources: [],
  queue: [],
  contributions: [],
  needs: [],
  summary: null,
});

/** Stateful fake of the auth + workspace endpoints. */
async function harness(page: Page, start: string | null) {
  const state = {
    current: start as keyof typeof orgs | null,
    selects: [] as unknown[],
    workspaceFetches: 0,
    posts: [] as Record<string, string>[],
  };
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          currentOrganizationId: state.current,
          options: Object.values(orgs),
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations/select", (route) => {
    const body = route.request().postDataJSON() as { organizationId: string };
    state.selects.push(body);
    if (body.organizationId in orgs) {
      state.current = body.organizationId as keyof typeof orgs;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    });
  });
  await page.route("**/api/product/workspace", (route) => {
    state.workspaceFetches++;
    return state.current
      ? route.fulfill({
          json: { ok: true, value: snapshotFor(state.current) },
        })
      : route.fulfill({
          status: 403,
          json: { ok: false, error: { code: "FORBIDDEN" } },
        });
  });
  return state;
}

test("product POSTs assert the rendered organization; GETs and pre-load do not", async ({
  page,
}) => {
  const state = await harness(page, "org-1");
  const headers: (string | undefined)[] = [];
  await page.route("**/api/product/sources", (route) => {
    headers.push(route.request().headers()["x-relay-org"]);
    return route.fulfill({
      json: {
        ok: true,
        value: {
          sourceId: "source-1",
          revision: 1,
          status: "received",
          correlationId: "c",
        },
      },
    });
  });
  const getHeaders: (string | undefined)[] = [];
  page.on("request", (request) => {
    if (request.method() === "GET" && request.url().includes("/api/"))
      getHeaders.push(request.headers()["x-relay-org"]);
  });
  await page.goto("/workspace/volunteer");
  await page.getByLabel("Your update").fill("Helped");
  // Another tab switches the active org; this tab still renders org-1.
  state.current = "org-2";
  await page.getByRole("button", { name: "Send update" }).click();
  await expect.poll(() => headers.length).toBe(1);
  expect(headers).toEqual(["org-1"]);
  expect(getHeaders.every((value) => value === undefined)).toBe(true);
});

test("a workspace-changed 409 shows a refresh prompt, keeps the draft and never retries", async ({
  page,
}) => {
  await harness(page, "org-1");
  let calls = 0;
  await page.route("**/api/product/sources", (route) => {
    calls++;
    return route.fulfill({
      status: 409,
      json: {
        ok: false,
        error: {
          code: "CONFLICT",
          message: "The workspace changed in another tab. Refresh to continue.",
          correlationId: "c",
          retryable: false,
        },
      },
    });
  });
  await page.goto("/workspace/volunteer");
  await page.getByLabel("Your update").fill("My draft");
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "The workspace changed in another tab" })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your update")).toHaveValue("My draft");
  await page.waitForTimeout(500);
  expect(calls).toBe(1);
  await expect(page.getByText("This record changed")).toHaveCount(0);
});

test("a record-changed 409 keeps the existing copy and no reload prompt", async ({
  page,
}) => {
  await harness(page, "org-1");
  await page.route("**/api/product/sources", (route) =>
    route.fulfill({
      status: 409,
      json: {
        ok: false,
        error: { code: "CONFLICT", message: "Stale", correlationId: "c" },
      },
    }),
  );
  await page.goto("/workspace/volunteer");
  await page.getByLabel("Your update").fill("x");
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(page.getByText("This record changed").first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reload workspace" }),
  ).toHaveCount(0);
});

test("?org= for another joined org selects it once and strips the param", async ({
  page,
}) => {
  const state = await harness(page, "org-1");
  await page.goto("/workspace/volunteer?org=org-2&x=1");
  await expect(page).toHaveURL(/\/workspace\/volunteer\?x=1$/);
  await expect(page.getByText("Second Org").first()).toBeVisible();
  expect(state.selects).toEqual([{ organizationId: "org-2" }]);
  expect(state.current).toBe("org-2");
});

test("?org= for a non-member shows no data, strips the param and does not loop", async ({
  page,
}) => {
  const state = await harness(page, null);
  await page.goto("/workspace?org=org-secret");
  await expect(page).toHaveURL(/\/workspace$/);
  // Normal no-active-org flow: the picker, with no hint of the target org.
  await expect(
    page.getByRole("heading", { name: "Choose an organization" }),
  ).toBeVisible();
  await expect(page.getByText("org-secret")).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(state.selects).toEqual([{ organizationId: "org-secret" }]);
});

test("?org= equal to the current org only strips the param", async ({
  page,
}) => {
  const state = await harness(page, "org-1");
  await page.goto("/workspace/volunteer?org=org-1");
  await expect(page).toHaveURL(/\/workspace\/volunteer$/);
  await expect(page.getByText("Community").first()).toBeVisible();
  expect(state.selects).toEqual([]);
});

test("a malformed ?org= is ignored and stripped", async ({ page }) => {
  const state = await harness(page, "org-1");
  await page.goto("/workspace/volunteer?org=..%2F..%2Fx");
  await expect(page).toHaveURL(/\/workspace\/volunteer$/);
  await expect(page.getByText("Community").first()).toBeVisible();
  expect(state.selects).toEqual([]);
});
