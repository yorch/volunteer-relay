import { expect, test } from "@playwright/test";
import { chooseOption } from "../helpers/controls.js";

test("review shows unknowns, field evidence, independent revision and safe state resets", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dev/review");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Every update has a story.",
  );
  const menu = page.getByText("Menu", { exact: true });
  const mobileMenu = await menu.isVisible();
  if (mobileMenu) await menu.click();
  await expect(
    page.getByRole("link", { name: "Source inbox", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  if (mobileMenu) await menu.click();
  await expect(
    page.locator("dd").filter({ hasText: /^Unknown duration$/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Review reason" })
    .fill("Old source reason");
  await page.getByRole("button", { name: /^Inez/ }).click();
  await expect(
    page.getByRole("textbox", { name: "Review reason" }),
  ).toHaveValue("");
  await expect(
    page.locator("dd").filter({ hasText: /^90 minutes$/ }),
  ).toBeVisible();
  await expect(
    page.getByText("Source revision 1 · America/New_York", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Review revision 12 · independent of source revision", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByText("Field evidence", { exact: true }).last().click();
  await expect(
    page.locator("blockquote").filter({ hasText: /^90 minutes$/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept preview" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeFocused();
  expect(
    await page
      .getByRole("button", { name: "Accept preview" })
      .evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe("solid");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Simulated acceptance — no data saved", { exact: true }),
  ).toBeVisible();
  // The preview adapter checks expectedRevision against the review aggregate (12), not source revision (1).
  await expect(page.getByText(/Preview review revision 13\./)).toBeVisible();
  await chooseOption(
    page.getByRole("combobox", { name: "Show updates" }),
    "urgent",
  );
  await expect(
    page.getByRole("heading", { name: "Original source" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Select an update" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Sol/ }).click();
  await expect(
    page.getByText("Provisional alert · unverified", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Review reason" }),
  ).toHaveValue("");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("review.png"),
    fullPage: true,
  });
  await page
    .getByRole("searchbox", { name: "Search synthetic updates" })
    .fill("no-such-source");
  await expect(
    page.getByRole("heading", { name: "No matching updates" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Original source" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Reject preview" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("shared contribution candidates remain separate and unresolved; source text never runs", async ({
  page,
}) => {
  await page.goto("/dev/review");
  await page.getByRole("button", { name: /^Mira/ }).click();
  await expect(
    page.getByRole("heading", { name: "Contribution candidate", exact: true }),
  ).toHaveCount(2);
  await expect(page.locator("dd").filter({ hasText: /^Mira$/ })).toBeVisible();
  await expect(page.locator("dd").filter({ hasText: /^Sol$/ })).toBeVisible();
  await expect(
    page.locator("dd").filter({ hasText: /^60 minutes$/ }),
  ).toHaveCount(2);
  await expect(page.getByText(/Sol already has a contribution/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: /^Robin/ }).click();
  await expect(
    page
      .locator("blockquote")
      .filter({ hasText: '<img src=x onerror="window.fixtureExecuted=true">' }),
  ).toBeVisible();
  await expect(page.getByRole("main").locator("img")).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "fixtureExecuted")),
  ).toBeUndefined();
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeDisabled();
});

test("rejection needs a reason, pending results stay with their source, conflict fails closed", async ({
  page,
}) => {
  await page.goto("/dev/review");
  await page.getByRole("button", { name: "Reject preview" }).click();
  const reason = page.getByRole("textbox", { name: "Review reason" });
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAccessibleDescription(
    /Add a reason before rejecting/,
  );
  await reason.fill("Synthetic clarification required.");
  await page.getByRole("button", { name: "Reject preview" }).click();
  await expect(
    page.getByRole("button", { name: "Reject preview" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Simulated rejection — no data saved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Rejecting a proposal does not withdraw a provisional alert/,
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Inez/ }).click();
  await page.getByRole("button", { name: "Accept preview" }).click();
  await page.getByRole("button", { name: /^Mira/ }).click();
  await expect(reason).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeDisabled();
  // Complete a different decision to ensure the old delayed success does not replace this detail.
  await reason.fill("Keep candidates unresolved.");
  await page.getByRole("button", { name: "Reject preview" }).click();
  await expect(
    page.getByText("Simulated rejection — no data saved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Simulated acceptance — no data saved", { exact: true }),
  ).toHaveCount(0);
  await chooseOption(
    page.getByRole("combobox", { name: "Preview response" }),
    "conflict",
  );
  await page.getByRole("button", { name: /^Inez/ }).click();
  await reason.fill("Reason survives a conflict.");
  await page.getByRole("button", { name: "Accept preview" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This review changed",
  );
  await expect(reason).toHaveValue("Reason survives a conflict.");
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Reject preview" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Reload preview" }).click();
  await expect(reason).toHaveValue("");
});

test("unavailable and empty inbox states stay explicit", async ({ page }) => {
  await page.goto("/dev/review");
  await chooseOption(
    page.getByRole("combobox", { name: "Preview response" }),
    "error",
  );
  await page.getByRole("button", { name: /^Inez/ }).click();
  await page
    .getByRole("textbox", { name: "Review reason" })
    .fill("Retained reason.");
  await page.getByRole("button", { name: "Accept preview" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "simulated review failed",
  );
  await expect(
    page.getByRole("textbox", { name: "Review reason" }),
  ).toHaveValue("Retained reason.");
  await expect(
    page.getByRole("button", { name: "Accept preview" }),
  ).toBeEnabled();
  await chooseOption(
    page.getByRole("combobox", { name: "Preview response" }),
    "empty",
  );
  await expect(
    page.getByRole("heading", { name: "No matching updates" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Original source" }),
  ).toHaveCount(0);
});
