import { expect, test } from "@playwright/test";

test("baseline loads without page errors and reports the pinned server runtime", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect(await health.json()).toEqual({
    status: "ok",
    service: "web",
    runtime: "26.11.1",
  });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: /A little clarity\.\s*More care\./i,
    }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Volunteer Relay");
  await expect(
    page.getByRole("link", { name: "volunteer relay." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
