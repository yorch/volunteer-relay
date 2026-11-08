import { expect, type Page, test } from "@playwright/test";

const email = "synthetic@example.test";
const password = "Synthetic-password-19!";
const failure = (code = "NOT_FOUND") => ({
  ok: false,
  error: {
    code,
    message: "PRIVATE-DETAIL",
    correlationId: "PRIVATE-CORRELATION",
    retryable: false,
  },
});
async function respond(
  page: Page,
  endpoint: string,
  body: unknown,
  status = 200,
) {
  await page.route(`**/api/auth/${endpoint}`, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}
test("sign in sends exact credentials, locks pending and ignores returnTo", async ({
  page,
}) => {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).startsWith("/api/auth/")) {
        document.documentElement.dataset.credentials = init?.credentials;
        document.documentElement.dataset.cache = init?.cache;
        document.documentElement.dataset.redirect = init?.redirect;
      }
      return original(input, init);
    };
  });
  await page.route("**/api/auth/sign-in", async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({ email, password });
    expect(route.request().headers()["content-type"]).toBe("application/json");
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await respond(page, "organizations", {
    ok: true,
    value: { currentOrganizationId: null, options: [] },
  });
  await page.goto("/sign-in?returnTo=https://example.invalid");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Please wait…" }),
  ).toBeDisabled();
  await expect.poll(() => calls).toBe(1);
  await page
    .getByRole("form", { name: "Sign in", exact: true })
    .evaluate((form) =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  expect(calls).toBe(1);
  await expect(page.locator("html")).toHaveAttribute(
    "data-credentials",
    "same-origin",
  );
  await expect(page.locator("html")).toHaveAttribute("data-cache", "no-store");
  await expect(page.locator("html")).toHaveAttribute("data-redirect", "error");
  release();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByText("No organizations are available.")).toBeVisible();
});

test("signup explains membership and sends canonical fields only", async ({
  page,
}) => {
  await page.route("**/api/auth/sign-up", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      name: "Synthetic Person",
      email,
      password,
    });
    return route.fulfill({
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await page.goto("/sign-up");
  await expect(
    page.getByText(/Creating an account grants no organization membership/),
  ).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Synthetic Person");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Account created.");
  await expect(page.getByRole("status")).toBeFocused();
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
    "",
  );
  expect(
    await page
      .locator(
        'input[name="role"],input[name="organizationId"],input[name="userId"]',
      )
      .count(),
  ).toBe(0);
});

test("reset and verification requests and confirmations use exact endpoints", async ({
  page,
}) => {
  for (const [path, endpoint, button] of [
    ["/reset-password", "reset/request", "Request reset"],
    ["/verify-email", "verification/request", "Request verification"],
  ] as const) {
    await page.route(`**/api/auth/${endpoint}`, (route) => {
      expect(route.request().postDataJSON()).toEqual({ email });
      return route.fulfill({
        contentType: "application/json",
        body: '{"ok":true}',
      });
    });
    await page.goto(path);
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "If this account is eligible",
    );
  }
  await page.route("**/api/auth/reset/confirm", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token: "synthetic-reset",
      newPassword: password,
    });
    return route.fulfill({
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await page.goto("/reset-password?token=synthetic-reset");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Password reset completed.",
  );
  await page.route("**/api/auth/verification/confirm", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token: "synthetic-verify",
    });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify(failure()),
    });
  });
  await page.goto("/verify-email?token=synthetic-verify");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "unavailable or expired",
  );
  await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
  await expect(page.locator("body")).not.toContainText("PRIVATE");
  await expect(page.locator('input[type="hidden"]')).toHaveCount(0);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

test("malformed, non-JSON, inconsistent and unavailable responses fail safely and allow retry", async ({
  page,
}) => {
  await page.goto("/reset-password");
  await page.getByLabel("Email", { exact: true }).fill(email);
  for (const [status, contentType, body] of [
    [200, "application/json", '{"ok":true,"token":"PRIVATE"}'],
    [200, "application/json", "{"],
    [200, "text/html", "PRIVATE"],
    [200, "application/json", JSON.stringify(failure())],
    [404, "application/json", '{"ok":true}'],
    [
      503,
      "application/json",
      JSON.stringify(failure("DEPENDENCY_UNAVAILABLE")),
    ],
  ] as const) {
    await page.route("**/api/auth/reset/request", (route) =>
      route.fulfill({ status, contentType, body }),
    );
    await page
      .getByRole("button", { name: "Request reset", exact: true })
      .click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "service is unavailable",
    );
    await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
    await expect(page.locator("body")).not.toContainText("PRIVATE");
    await expect(
      page.getByRole("button", { name: "Request reset", exact: true }),
    ).toBeEnabled();
    await page.unroute("**/api/auth/reset/request");
  }
  await respond(page, "reset/request", { ok: true });
  await page
    .getByRole("button", { name: "Request reset", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "If this account is eligible",
  );
});

test("account loads live choices, switches with only organization ID and signs out", async ({
  page,
}) => {
  const options = [
    {
      organizationId: "synthetic-a",
      membershipId: "member-a",
      name: "Synthetic Garden",
      slug: "synthetic-garden",
      role: "volunteer",
    },
    {
      organizationId: "synthetic-b",
      membershipId: "member-b",
      name: "Synthetic Library",
      slug: "synthetic-library",
      role: "report-reader",
    },
  ];
  let current = "synthetic-a";
  let releaseOrganizations: () => void = () => {};
  const organizationsGate = new Promise<void>((resolve) => {
    releaseOrganizations = resolve;
  });
  await page.route("**/api/auth/organizations", async (route) => {
    await organizationsGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        value: { currentOrganizationId: current, options },
      }),
    });
  });
  await page.route("**/api/auth/organizations/select", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      organizationId: "synthetic-b",
    });
    current = "synthetic-b";
    return route.fulfill({
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await page.route("**/api/auth/sign-out", (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await page.goto("/account");
  await expect(page.getByText("Loading organizations…")).toBeVisible();
  releaseOrganizations();
  await page
    .getByLabel("Organization", { exact: true })
    .selectOption("synthetic-b");
  await page
    .getByRole("button", { name: "Switch organization", exact: true })
    .click();
  await expect(page.getByLabel("Organization", { exact: true })).toHaveValue(
    "synthetic-b",
  );
  const selectionStatus = page
    .getByRole("form", { name: "Switch organization" })
    .getByRole("status");
  await expect(selectionStatus).toContainText(
    "Organization selection request completed.",
  );
  await expect(selectionStatus).toBeFocused();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("account unauthenticated, malformed, error and empty states retry safely", async ({
  page,
}) => {
  await respond(page, "organizations", failure("UNAUTHENTICATED"), 401);
  await page.goto("/account");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Please sign in",
  );
  await expect(page.getByRole("main").getByRole("alert")).toBeFocused();
  await page.unroute("**/api/auth/organizations");
  await respond(page, "organizations", {
    ok: true,
    value: { currentOrganizationId: "missing", options: [] },
  });
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "could not load",
  );
  await page.unroute("**/api/auth/organizations");
  await respond(page, "organizations", {
    ok: true,
    value: { currentOrganizationId: null, options: [] },
  });
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No organizations are available.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch organization", exact: true }),
  ).toBeDisabled();
});

test("invitation uses route ID, denies expired link and has responsive fixed navigation", async ({
  page,
}) => {
  await page.route("**/api/auth/invitations/accept", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      invitationId: "synthetic-invitation",
    });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify(failure()),
    });
  });
  await page.goto("/invitations/synthetic-invitation");
  await expect(
    page.getByText(/matching verified recipient email/),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "unavailable or expired",
  );
  const links = await page
    .getByRole("navigation", { name: "Account navigation" })
    .getByRole("link")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("href")),
    );
  expect(links).toEqual([
    "/sign-in",
    "/sign-up",
    "/reset-password",
    "/verify-email",
    "/account",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath("invitation.png"),
    fullPage: true,
  });
});

test("confirmation and invitation success, expired reset and network failure remain safe", async ({
  page,
}) => {
  await respond(page, "reset/confirm", failure(), 404);
  await page.goto("/reset-password?token=synthetic-expired");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "unavailable or expired",
  );
  await expect(page.getByLabel("New password", { exact: true })).toHaveValue(
    password,
  );
  await respond(page, "verification/confirm", { ok: true });
  await page.goto("/verify-email?token=synthetic-verification");
  await page.getByRole("button", { name: "Verify email", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Email verified.");
  await respond(page, "invitations/accept", { ok: true });
  await page.goto("/invitations/synthetic-invitation");
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Invitation request completed.",
  );
  await page.route("**/api/auth/sign-in", (route) => route.abort("failed"));
  await page.goto("/sign-in");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "service is unavailable",
  );
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeEnabled();
});

test("all page shells fit viewport, expose keyboard focus and do not emit secrets", async ({
  page,
}, info) => {
  const logged: string[] = [];
  page.on("console", (message) => logged.push(message.text()));
  page.on("pageerror", (error) => logged.push(error.message));
  await respond(page, "organizations", {
    ok: true,
    value: { currentOrganizationId: null, options: [] },
  });
  for (const [index, path] of [
    "/sign-in",
    "/sign-up",
    "/reset-password",
    "/reset-password?token=synthetic-private-token",
    "/verify-email",
    "/verify-email?token=synthetic-private-token",
    "/invitations/synthetic-invitation",
    "/account",
  ].entries()) {
    await page.goto(path);
    await expect(
      page.getByRole("main").getByRole("heading", { level: 1 }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByRole("main")).not.toContainText(
      "synthetic-private-token",
    );
    await expect(
      page.locator(
        'input[name="token"],input[name="invitationId"],input[name="userId"],input[name="role"]',
      ),
    ).toHaveCount(0);
    const focusTarget = page
      .getByRole("navigation", { name: "Account navigation" })
      .getByRole("link")
      .first();
    await focusTarget.focus();
    await expect(focusTarget).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("navigation").getByRole("link").nth(1),
    ).toBeFocused();
    await page.screenshot({
      path: info.outputPath(`page-${index}.png`),
      fullPage: true,
    });
  }
  expect(logged.join(" ")).not.toContain("synthetic-private-token");
  expect(logged.join(" ")).not.toContain(password);
  expect(
    await page.evaluate(() => [localStorage.length, sessionStorage.length]),
  ).toEqual([0, 0]);
});

test("empty or ambiguous tokens cannot submit confirmation", async ({
  page,
}) => {
  for (const path of [
    "/reset-password?token=",
    "/reset-password?token=a&token=b",
    "/verify-email?token=",
    "/verify-email?token=a&token=b",
  ]) {
    await page.goto(path);
    await expect(
      page.getByRole("main").getByRole("form").getByRole("button"),
    ).toBeDisabled();
  }
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("credential controls cannot submit before hydration", async ({
    page,
  }) => {
    for (const path of [
      "/sign-in",
      "/sign-up",
      "/reset-password",
      "/reset-password?token=synthetic-reset",
    ]) {
      await page.goto(path);
      const form = page.getByRole("main").getByRole("form");
      await expect(form).toHaveAttribute("method", "post");
      await expect(form.getByRole("button")).toBeDisabled();
      for (const input of await form.locator("input").all())
        await expect(input).toBeDisabled();
      await expect(
        page.getByText("Enable JavaScript to use this form safely."),
      ).toBeVisible();
      expect(new URL(page.url()).searchParams.has("password")).toBe(false);
      expect(new URL(page.url()).searchParams.has("newPassword")).toBe(false);
    }
  });
});
