import { expect, type Page, test } from "@playwright/test";

const invitations = [
  {
    invitationId: "invitation-garden",
    organizationName: "Synthetic Garden",
    role: "volunteer",
    expiresAt: "2026-12-01T12:00:00.000Z",
  },
  {
    invitationId: "invitation-pantry",
    organizationName: "Synthetic Pantry",
    role: "coordinator",
    expiresAt: "2026-12-02T12:00:00.000Z",
  },
];

// A signed-in user with no organizations reaches the zero-organization panel.
async function zeroOrganizations(page: Page, list: unknown) {
  let workspaceCalls = 0;
  await page.route("**/api/product/workspace", (route) => {
    workspaceCalls += 1;
    return route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    });
  });
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: { ok: true, value: { currentOrganizationId: null, options: [] } },
    }),
  );
  let listCalls = 0;
  await page.route("**/api/auth/invitations", (route) => {
    listCalls += 1;
    return route.fulfill(
      typeof list === "number"
        ? {
            status: list,
            json: {
              ok: false,
              error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Unavailable",
                correlationId: "c",
                retryable: true,
              },
            },
          }
        : { json: { ok: true, value: list } },
    );
  });
  return {
    listCalls: () => listCalls,
    workspaceCalls: () => workspaceCalls,
  };
}

const heading = (page: Page) =>
  page.getByRole("heading", { name: "You're not in an organization yet" });

test("zero-organization user accepts a pending invitation and opens the workspace", async ({
  page,
}) => {
  const calls = await zeroOrganizations(page, {
    emailVerified: true,
    invitations,
  });
  let accepted: unknown = null;
  await page.route("**/api/auth/invitations/accept", async (route) => {
    accepted = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/workspace");
  await expect(heading(page)).toBeVisible();
  const list = page.getByRole("region", {
    name: "Invitations waiting for you",
  });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(
    list.getByRole("heading", { name: "Synthetic Garden" }),
  ).toBeVisible();
  await expect(list.getByText("Role: Coordinator")).toBeVisible();
  await expect(
    list.locator('time[datetime="2026-12-01T12:00:00.000Z"]'),
  ).toBeVisible();
  expect(calls.listCalls()).toBe(1);

  // Once accepted, the reload of /workspace finds the new membership.
  await page.unroute("**/api/product/workspace");
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } },
    }),
  );
  await page
    .getByRole("button", { name: "Accept invitation to Synthetic Pantry" })
    .click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByText("Workspace unavailable")).toBeVisible();
  expect(accepted).toEqual({ invitationId: "invitation-pantry" });
});

test("an empty list keeps the invitation guidance and sign out", async ({
  page,
}) => {
  await zeroOrganizations(page, { emailVerified: true, invitations: [] });
  await page.goto("/workspace");
  await expect(heading(page)).toBeVisible();
  await expect(
    page.getByText("An owner or coordinator needs to invite you."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "verified" })).toHaveAttribute(
    "href",
    "/verify-email",
  );
  await expect(
    page.getByRole("region", { name: "Invitations waiting for you" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("a refused acceptance shows a neutral error and keeps the list", async ({
  page,
}) => {
  await zeroOrganizations(page, { emailVerified: true, invitations });
  await page.route("**/api/auth/invitations/accept", (route) =>
    route.fulfill({
      status: 403,
      json: {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message: "Request is not permitted",
          correlationId: "c",
          retryable: false,
        },
      },
    }),
  );
  await page.goto("/workspace");
  await page
    .getByRole("button", { name: "Accept invitation to Synthetic Garden" })
    .click();
  await expect(page.getByRole("alert").first()).toContainText(
    "This invitation could not be accepted.",
  );
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(heading(page)).toBeVisible();
  const list = page.getByRole("region", {
    name: "Invitations waiting for you",
  });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Accept invitation to Synthetic Garden" }),
  ).toBeEnabled();
});

test("specific acceptance refusals show their own copy and keep the list", async ({
  page,
}) => {
  await zeroOrganizations(page, { emailVerified: true, invitations });
  let reply: { status: number; code: string } = {
    status: 410,
    code: "INVITATION_EXPIRED",
  };
  await page.route("**/api/auth/invitations/accept", (route) =>
    route.fulfill({
      status: reply.status,
      json: {
        ok: false,
        error: {
          code: reply.code,
          message: "PRIVATE-DETAIL",
          correlationId: "c",
          retryable: false,
        },
      },
    }),
  );
  await page.goto("/workspace");
  const accept = page.getByRole("button", {
    name: "Accept invitation to Synthetic Garden",
  });
  await accept.click();
  const alert = page.getByRole("alert").first();
  await expect(alert).toHaveText(
    "This invitation has expired. Ask the organization to send a new invitation.",
  );
  reply = { status: 404, code: "NOT_AVAILABLE" };
  await accept.click();
  await expect(alert).toHaveText(
    "This invitation is not available to this account. It may have been used or withdrawn, or sent to a different email address.",
  );
  await expect(page.getByText("PRIVATE-DETAIL")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Invitations waiting for you" })
      .getByRole("listitem"),
  ).toHaveCount(2);
});

test("an unverified user sees the verify link and no invitation list", async ({
  page,
}) => {
  await zeroOrganizations(page, { emailVerified: false, invitations: [] });
  await page.goto("/workspace");
  await expect(heading(page)).toBeVisible();
  await expect(
    page.getByText("Your email address is not verified yet."),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Verify your email" }),
  ).toHaveAttribute("href", "/verify-email");
  await expect(
    page.getByRole("region", { name: "Invitations waiting for you" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Accept/ })).toHaveCount(0);
});

test("an unavailable list falls back to the guidance with a neutral notice", async ({
  page,
}) => {
  await zeroOrganizations(page, 503);
  await page.goto("/workspace");
  await expect(heading(page)).toBeVisible();
  await expect(
    page.getByText("Invitations could not be loaded right now."),
  ).toBeVisible();
  await expect(
    page.getByText("An owner or coordinator needs to invite you."),
  ).toBeVisible();
});

test("a user with an organization never requests the invitation list", async ({
  page,
}) => {
  const organization = {
    organizationId: "org-1",
    name: "Community",
    slug: "community",
    role: "volunteer",
    membershipId: "member-1",
  };
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: { currentOrganizationId: null, options: [organization] },
      },
    }),
  );
  let listCalls = 0;
  await page.route("**/api/auth/invitations", (route) => {
    listCalls += 1;
    return route.fulfill({
      json: { ok: true, value: { emailVerified: true, invitations } },
    });
  });
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "Choose an organization" }),
  ).toBeVisible();
  expect(listCalls).toBe(0);
});
