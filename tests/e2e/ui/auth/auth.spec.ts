import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/dev/auth");
});

test("labels, keyboard focus, safe sign-in payload and pending lock", async ({
  page,
}) => {
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  const email = form.getByLabel("Email", { exact: true });
  const password = form.getByLabel("Password", { exact: true });
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await email.focus();
  await email.fill("synthetic@example.invalid");
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await password.fill("synthetic-private-password");
  await page.keyboard.press("Tab");
  await expect(form.getByRole("button")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(form).toHaveAttribute("aria-busy", "true");
  await expect(password).toBeDisabled();
  await expect(form.getByRole("button")).toBeDisabled();
  await expect(form.getByRole("status")).toHaveText(
    "Sign-in request completed.",
  );
  await expect(form.getByRole("status")).toBeFocused();
  await expect(password).toHaveValue("");
  await expect(email).toHaveValue("synthetic@example.invalid");
  await expect(page.getByTestId("calls")).toHaveText("1");
  await expect(
    page.getByText("Payload keys: expected", { exact: false }),
  ).toBeVisible();
  expect(logs.join(" ")).not.toContain("synthetic-private-password");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(page.url()).not.toContain("password");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("safe errors preserve drafts and thrown callbacks recover", async ({
  page,
}) => {
  await page.getByLabel("Simulated outcome").selectOption("error");
  const form = page.getByRole("form", { name: "Sign in", exact: true });
  await form.getByLabel("Email").fill("synthetic@example.invalid");
  await form
    .getByLabel("Password", { exact: true })
    .fill("retained-synthetic-secret");
  await form.getByRole("button").click();
  await expect(form.getByRole("alert")).toContainText("Check your details");
  await expect(form.getByLabel("Password", { exact: true })).toHaveValue(
    "retained-synthetic-secret",
  );
  await expect(
    page.getByText("Synthetic private transport detail"),
  ).toHaveCount(0);
  await page.getByLabel("Simulated outcome").selectOption("throw");
  await form.getByRole("button").click();
  await expect(form.getByRole("alert")).toContainText("service is unavailable");
  await expect(form.getByRole("button")).toBeEnabled();
  await page.getByLabel("Simulated outcome").selectOption("success");
  await form.getByRole("button").click();
  await expect(form.getByRole("status")).toContainText("completed");
  await expect(form.getByLabel("Password", { exact: true })).toHaveValue("");
});

test("reset requests use the same opaque acknowledgement for different accounts", async ({
  page,
}) => {
  const form = page.getByRole("form", { name: "Request a password reset" });
  const acknowledgement =
    "If this account is eligible, reset instructions may be sent. Check your email for any next steps.";
  for (const email of [
    "known-synthetic@example.invalid",
    "unknown-synthetic@example.invalid",
  ]) {
    await form.getByLabel("Email").fill(email);
    await form.getByRole("button").click();
    await expect(form.getByRole("button")).toBeDisabled();
    await expect(form.getByRole("status")).toHaveText(acknowledgement);
  }
  await expect(
    page.getByText("Payload keys: expected", { exact: false }),
  ).toBeVisible();
});

test("reset confirmation and invitation use supplied identifiers without authority inputs", async ({
  page,
}) => {
  const reset = page.getByRole("form", { name: "Choose a new password" });
  await expect(reset.getByLabel("New password")).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await reset.getByLabel("New password").fill("synthetic-new-secret");
  await reset.getByRole("button").click();
  await expect(reset.getByRole("status")).toHaveText(
    "Password reset completed.",
  );
  await expect(reset.getByLabel("New password")).toHaveValue("");
  const invitation = page.getByRole("form", { name: "Accept invitation" });
  await invitation.getByRole("button").click();
  await expect(invitation.getByRole("button")).toBeDisabled();
  await expect(invitation.getByRole("status")).toHaveText(
    "Invitation request completed.",
  );
  await expect(
    page.locator(
      'input[name="role"], input[name="token"], input[name="invitationId"], input[name="membershipId"]',
    ),
  ).toHaveCount(0);
  await expect(
    page.getByText("Payload keys: expected", { exact: false }),
  ).toBeVisible();
});

test("organization choices are server supplied, empty choices lock actions", async ({
  page,
}) => {
  const form = page.getByRole("form", { name: "Switch organization" }).first();
  const choice = form.getByLabel("Organization", { exact: true });
  await expect(choice).toHaveValue("synthetic-garden");
  await expect(choice.locator("option")).toHaveText([
    "Choose an organization",
    "Synthetic Garden (volunteer)",
    "Synthetic Library (report-reader)",
  ]);
  await choice.selectOption("synthetic-library");
  await form.getByRole("button").click();
  await expect(choice).toBeDisabled();
  await expect(form.getByRole("status")).toContainText("completed");
  await expect(
    page
      .getByRole("form", { name: "Switch organization" })
      .first()
      .getByLabel("Organization", { exact: true }),
  ).toHaveValue("synthetic-library");
  const empty = page.getByRole("form", { name: "Switch organization" }).last();
  await expect(empty.getByRole("button")).toBeDisabled();
  await expect(
    empty.getByText("No organizations are available."),
  ).toBeVisible();
  await expect(
    page.getByText("Payload keys: expected", { exact: false }),
  ).toBeVisible();
});

test("every callback error releases its lock and keeps a safe retry available", async ({
  page,
}) => {
  await page.getByLabel("Simulated outcome").selectOption("error");
  const request = page.getByRole("form", { name: "Request a password reset" });
  await request.getByLabel("Email").fill("synthetic@example.invalid");
  const reset = page.getByRole("form", { name: "Choose a new password" });
  await reset.getByLabel("New password").fill("synthetic-draft-password");
  const invitation = page.getByRole("form", { name: "Accept invitation" });
  const organization = page
    .getByRole("form", { name: "Switch organization" })
    .first();
  for (const form of [request, reset, invitation, organization]) {
    await form.getByRole("button").click();
    await expect(form).toHaveAttribute("aria-busy", "true");
    await expect(form.getByRole("alert")).toContainText("Check your details");
    await expect(form.getByRole("alert")).toBeFocused();
    await expect(form.getByRole("button")).toBeEnabled();
  }
  await expect(reset.getByLabel("New password")).toHaveValue(
    "synthetic-draft-password",
  );
  await expect(
    organization.getByLabel("Organization", { exact: true }),
  ).toHaveValue("synthetic-garden");
});

test("preview layout remains readable with visible keyboard focus", async ({
  page,
}, testInfo) => {
  await page.getByLabel("Simulated outcome").focus();
  const outline = await page
    .getByLabel("Simulated outcome")
    .evaluate((element) => getComputedStyle(element).outlineStyle);
  expect(outline).not.toBe("none");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("auth-preview.png"),
    fullPage: true,
  });
});
