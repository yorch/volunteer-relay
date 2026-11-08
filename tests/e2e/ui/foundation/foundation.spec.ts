import { expect, test } from "@playwright/test";

for (const audience of ["staff", "volunteer"] as const) {
  test(`${audience} shell fits, labels states and supports keyboard input`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/dev/foundation?audience=${audience}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(
      page.getByText("Duration unknown", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Provisional alert", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toContainText(
      "Updates could not be loaded",
    );
    await expect(
      page.getByText("No updates to show", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Checking for updates…", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (audience === "staff") {
      if ((page.viewportSize()?.width ?? 1440) <= 760) {
        await expect(
          page.getByRole("navigation", { name: "Workspace" }),
        ).toBeHidden();
        await page.getByText("Menu", { exact: true }).click();
      }
      await expect(
        page.getByRole("navigation", { name: "Workspace" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Foundation", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      if ((page.viewportSize()?.width ?? 1440) <= 760) await page.reload();
    } else {
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Foundation", exact: true }),
      ).toHaveCount(0);
    }
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("link", { name: "Skip to main content" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
    // Staff specimen has a same-page link to the first field; after skip, tab enters content.
    await page.keyboard.press("Tab");
    const update = page.getByRole("textbox", { name: "Your update" });
    await expect(update).toBeFocused();
    expect(
      await update.evaluate((el) => getComputedStyle(el).outlineStyle),
    ).toBe("solid");
    await page.keyboard.type("Synthetic keyboard-only update.");
    await expect(update).toHaveValue("Synthetic keyboard-only update.");
    await page.keyboard.press("Tab");
    const upload = page.getByLabel("Add a photo (optional)");
    await expect(upload).toBeFocused();
    await upload.setInputFiles("fixtures/images/box-26.png");
    expect(
      await upload.evaluate((el) => (el as HTMLInputElement).files?.[0]?.name),
    ).toBe("box-26.png");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("searchbox", { name: "Find an update" }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Submission unavailable in preview" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("textbox", { name: "Required detail" }),
    ).toHaveAccessibleDescription("Add a description before continuing.");
    await expect(
      page.getByRole("combobox", { name: "Display state" }),
    ).toHaveValue("unknown");
    expect(errors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`${audience}.png`),
      fullPage: true,
    });
    await testInfo.attach(`${audience} viewport`, {
      path: testInfo.outputPath(`${audience}.png`),
      contentType: "image/png",
    });
  });
}

test("text and control palette meets WCAG contrast thresholds", async ({
  page,
}) => {
  await page.goto("/dev/foundation");
  const contrast = await page.locator("main").evaluate((main) => {
    const parse = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = (rgb: number[]) =>
      rgb.slice(0, 3).reduce((total, v, i) => {
        const c = v / 255;
        return (
          total +
          (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
            ([0.2126, 0.7152, 0.0722][i] ?? 0)
        );
      }, 0);
    return [
      ...main.querySelectorAll(
        "h1,h2,h3,p,label,button,select,input,textarea,span,strong",
      ),
    ]
      .filter((el) => !(el instanceof HTMLButtonElement && el.disabled))
      .map((el) => {
        const fg = parse(getComputedStyle(el).color);
        let parent: Element | null = el;
        let bg = [255, 255, 255];
        while (parent) {
          const color = parse(getComputedStyle(parent).backgroundColor);
          if (color.length === 3 || color[3] === 1) {
            bg = color;
            break;
          }
          parent = parent.parentElement;
        }
        return {
          text: el.textContent?.slice(0, 45) || el.tagName,
          ratio:
            (Math.max(lum(fg), lum(bg)) + 0.05) /
            (Math.min(lum(fg), lum(bg)) + 0.05),
        };
      });
  });
  for (const { text, ratio } of contrast)
    expect(ratio, text).toBeGreaterThanOrEqual(4.5);
});
