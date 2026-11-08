import { expect, type Locator } from "@playwright/test";

async function isNative(locator: Locator): Promise<boolean> {
  return locator.evaluate((node) => node.tagName === "SELECT");
}

async function openCustom(locator: Locator): Promise<Locator> {
  if ((await locator.getAttribute("aria-expanded")) !== "true") {
    await locator.click();
  }
  const listId = await locator.getAttribute("aria-controls");
  const list = locator.page().locator(`[id="${listId}"]`);
  await expect(list).toBeVisible();
  return list;
}

/** Choose an option by value in a native <select> or the foundation Select. */
export async function chooseOption(
  locator: Locator,
  value: string,
): Promise<void> {
  if (await isNative(locator)) {
    await locator.selectOption(value);
    return;
  }
  const list = await openCustom(locator);
  await list.locator(`[role="option"][data-value="${value}"]`).click();
  await expect(list).toBeHidden();
}

/** Assert the selected value of a native <select> or the foundation Select. */
export async function expectOption(
  locator: Locator,
  value: string,
): Promise<void> {
  if (await isNative(locator)) {
    await expect(locator).toHaveValue(value);
    return;
  }
  await expect(locator).toHaveAttribute("data-value", value);
}

/** Assert the visible labels of every option, in order. */
export async function expectOptionTexts(
  locator: Locator,
  texts: string[],
): Promise<void> {
  if (await isNative(locator)) {
    await expect(locator.locator("option")).toHaveText(texts);
    return;
  }
  const list = await openCustom(locator);
  await expect(list.locator('[role="option"]')).toHaveText(texts);
  await locator.press("Escape");
  await expect(list).toBeHidden();
}
