import { expect, test } from "@playwright/test";

const option = (n: number, name: string) => ({
  organizationId: `org-${n}`,
  name,
  slug: name.toLowerCase(),
  role: "coordinator",
  membershipId: `member-${n}`,
});

// These states render before any shell exists. They must bring their own
// foundation styling: a primary button with no background and white text is
// invisible on the page canvas.
test("organization picker is styled and its action is readable", async ({
  page,
}) => {
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
        value: {
          currentOrganizationId: null,
          options: [option(1, "Community"), option(2, "Second")],
        },
      },
    }),
  );
  await page.goto("/workspace");
  await page.getByRole("radio", { name: /Community/ }).check();
  const button = page.getByRole("button", { name: "Open workspace" });
  await expect(button).toBeEnabled();
  const style = await button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, color: s.color };
  });
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.background).not.toBe(style.color);
  // Custom radio (appearance none), and the page canvas is applied.
  expect(
    await page
      .getByRole("radio", { name: /Community/ })
      .evaluate((el) => getComputedStyle(el).appearance),
  ).toBe("none");
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(
          document.querySelector("main")?.parentElement as Element,
        ).backgroundColor,
    ),
  ).not.toBe("rgba(0, 0, 0, 0)");
});
