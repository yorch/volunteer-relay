import { expect, test } from "@playwright/test";

// Audits every visible text-bearing element (links and buttons included) on
// the main workspace routes in their empty states, where button-like links in
// cards were once unreadable (teal text on a teal background).
const organization = {
  organizationId: "org-1",
  name: "Community",
  slug: "community",
  role: "owner",
  membershipId: "member-1",
};
const snapshot = {
  organization,
  members: [],
  sources: [],
  queue: [],
  contributions: [],
  needs: [],
  summary: null,
};

const routes = [
  "/workspace",
  "/workspace/inbox",
  "/workspace/needs",
  "/workspace/activities",
  "/workspace/history",
  "/workspace/delivery",
  "/workspace/retention",
  "/workspace/notifications",
  "/workspace/settings",
  "/workspace/members",
  "/workspace/reports",
  "/workspace/import",
];

test("text on workspace pages meets WCAG contrast", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({ json: { ok: true, value: { approvedHours: 0 } } }),
  );
  await page.route("**/api/product/notifications", (route) =>
    route.fulfill({ json: { ok: true, value: [] } }),
  );
  const failures: string[] = [];
  for (const path of routes) {
    await page.goto(path);
    await expect(page.locator("main#workspace-main")).toBeVisible();
    const found = await page.locator("main#workspace-main").evaluate((main) => {
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
      const out: string[] = [];
      for (const el of main.querySelectorAll("*")) {
        const hasText = [...el.childNodes].some(
          (n) => n.nodeType === 3 && (n.textContent ?? "").trim(),
        );
        if (!hasText) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none") continue;
        if (el instanceof HTMLButtonElement && el.disabled) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const fg = parse(style.color);
        let bg = [255, 255, 255];
        for (let p: Element | null = el; p; p = p.parentElement) {
          const c = parse(getComputedStyle(p).backgroundColor);
          if (c.length === 3 || c[3] === 1) {
            bg = c;
            break;
          }
        }
        const ratio =
          (Math.max(lum(fg), lum(bg)) + 0.05) /
          (Math.min(lum(fg), lum(bg)) + 0.05);
        const px = Number.parseFloat(style.fontSize);
        const large =
          px >= 24 || (px >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5))
          out.push(
            `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 40)}" ${ratio.toFixed(2)}`,
          );
      }
      return out;
    });
    for (const f of found) failures.push(`${path}: ${f}`);
  }
  expect(failures).toEqual([]);
});
