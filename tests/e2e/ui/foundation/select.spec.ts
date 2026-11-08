import { expect, test } from "@playwright/test";
import { expectOption } from "../helpers/controls.js";

test("custom select follows the APG select-only combobox pattern", async ({
  page,
}) => {
  await page.goto("/dev/foundation?audience=staff");
  const trigger = page.getByRole("combobox", { name: "Display state" });
  await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expectOption(trigger, "unknown");
  await expect(trigger).toContainText("Unknown");
  await expect(page.locator("select")).toHaveCount(0);

  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const list = page.getByRole("listbox");
  await expect(list).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list.getByRole("option", { name: "Unknown" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("ArrowDown");
  await expect(trigger).toHaveAttribute(
    "aria-activedescendant",
    (await list.getByRole("option").nth(1).getAttribute("id")) ?? "",
  );
  await page.keyboard.press("Enter");
  await expect(list).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectOption(trigger, "pending");

  await page.keyboard.press("Space");
  await expect(list).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(trigger).toBeFocused();
  await expectOption(trigger, "pending");

  // Type-ahead moves to the matching option.
  await page.keyboard.type("u");
  await expect(list).toBeVisible();
  await page.keyboard.press("Enter");
  await expectOption(trigger, "unknown");

  // Outside click closes without changing the value.
  await trigger.click();
  await expect(list).toBeVisible();
  await page.getByRole("heading", { level: 1 }).click();
  await expect(list).toBeHidden();
  await expectOption(trigger, "unknown");

  // Pointer selection.
  await trigger.click();
  await list.getByRole("option", { name: "Pending review" }).click();
  await expectOption(trigger, "pending");
});

test("custom select fits at 320px without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/dev/foundation?audience=staff");
  const trigger = page.getByRole("combobox", { name: "Display state" });
  await trigger.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  const box = await trigger.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
