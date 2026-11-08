import { expect, test } from "@playwright/test";

test("text preview validates, supports keyboard and presents only a simulated receipt", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dev/intake");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "How did you help today?",
  );
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(
    page.getByText("Development preview — no data saved", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("combobox", { name: "Preview response" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const text = page.getByRole("textbox", { name: "Your update" });
  await expect(text).toBeFocused();
  expect(await text.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe(
    "solid",
  );
  await text.fill("   ");
  await page.getByRole("button", { name: "Send preview update" }).click();
  await expect(text).toBeFocused();
  await expect(text).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText(/Write an update of 1–20,000 characters/).first(),
  ).toBeVisible();
  await text.fill(
    "I helped for 90 minutes. <script>window.fixtureExecuted=true</script>",
  );
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", { name: "Sending preview…" }),
  ).toBeDisabled();
  await expect(text).toBeDisabled();
  await expect(
    page.getByText("Simulated receipt — no data saved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("simulated-text-receipt", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /inbox|staff/i })).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "fixtureExecuted")),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("receipt.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Write another preview update" })
    .click();
  await expect(text).toHaveValue("");
  await page.reload();
  await expect(text).toHaveValue("");
  expect(errors).toEqual([]);
  await page.screenshot({
    path: info.outputPath("intake.png"),
    fullPage: true,
  });
});

test("failed submission retains draft and same-key retry succeeds", async ({
  page,
}) => {
  await page.goto("/dev/intake");
  await page
    .getByRole("combobox", { name: "Preview response" })
    .selectOption("retry");
  const text = page.getByRole("textbox", { name: "Your update" });
  await text.fill("Synthetic draft kept for retry.");
  await page.getByRole("button", { name: "Send preview update" }).click();
  await expect(
    page.getByRole("button", { name: "Try preview again" }),
  ).toBeEnabled();
  await expect(text).toHaveValue("Synthetic draft kept for retry.");
  await page.getByRole("button", { name: "Try preview again" }).click();
  await expect(
    page.getByText("Simulated receipt — no data saved", { exact: true }),
  ).toBeVisible();
  // The controlled adapter returns conflict if a retry changes its key or payload.
  await page
    .getByRole("combobox", { name: "Preview response" })
    .selectOption("error");
  await text.fill("Another unsaved draft.");
  await page.getByRole("button", { name: "Send preview update" }).click();
  await expect(
    page.getByRole("button", { name: "Try preview again" }),
  ).toBeEnabled();
  await expect(text).toHaveValue("Another unsaved draft.");
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "draft is still here",
  );
});

test("oversized draft is rejected before the simulated callback", async ({
  page,
}) => {
  await page.goto("/dev/intake");
  const text = page.getByRole("textbox", { name: "Your update" });
  await text.fill("x".repeat(20001));
  await page.getByRole("button", { name: "Send preview update" }).click();
  await expect(text).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Simulated receipt — no data saved", { exact: true }),
  ).toHaveCount(0);
});
