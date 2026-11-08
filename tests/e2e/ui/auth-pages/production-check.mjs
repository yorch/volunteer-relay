// Run after bun run verify, from the worktree root; uses only port 3173.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chromium, expect } from "@playwright/test";

assert.equal(process.versions.node, "26.11.1");
const origin = "http://127.0.0.1:3173";
try {
  await fetch(`${origin}/api/health`);
  throw new Error("Private port 3173 is occupied; preserve its owner.");
} catch (error) {
  if (error.message.includes("occupied")) throw error;
}
const server = spawn(
  process.execPath,
  [
    "apps/web/node_modules/next/dist/bin/next",
    "start",
    "apps/web",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3173",
  ],
  {
    env: {
      ...process.env,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: randomBytes(48).toString("hex"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: "ignore",
  },
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Production server exited");
    try {
      ready = (await fetch(`${origin}/api/health`)).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, "Production health ready");
  browser = await chromium.launch();
  for (const width of [1440, 1024, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    for (const path of ["/dev/auth", "/dev/auth?variant=reset"]) {
      const response = await page.goto(`${origin}${path}`);
      assert.equal(response.status(), 404);
      const body = await response.text();
      for (const marker of [
        "Simulated authentication",
        "synthetic-reset-token",
        "synthetic-invitation",
        "Synthetic Garden",
      ])
        assert.ok(!body.includes(marker), `No fixture marker: ${marker}`);
      assert.equal(await page.locator("form").count(), 0);
    }
    for (const path of [
      "/sign-in",
      "/sign-up",
      "/reset-password",
      "/verify-email",
      "/invitations/synthetic-production-invitation",
      "/account",
    ]) {
      const response = await page.goto(`${origin}${path}`);
      assert.equal(response.status(), 200, `Production page ${path}`);
      assert.equal(await page.getByRole("main").count(), 1);
      await expect(
        page.getByRole("main").getByRole("form").first().getByRole("button"),
      ).toBeEnabled();
      assert.equal(
        await page
          .getByRole("navigation", { name: "Account navigation" })
          .count(),
        1,
      );
    }
    await page.close();
    const noScriptPage = await browser.newPage({
      viewport: { width, height: 900 },
      javaScriptEnabled: false,
    });
    await noScriptPage.goto(`${origin}/sign-up`);
    await expect(noScriptPage.getByRole("form")).toHaveAttribute(
      "method",
      "post",
    );
    await expect(
      noScriptPage.getByRole("form").getByRole("button"),
    ).toBeDisabled();
    for (const input of await noScriptPage.locator("input").all())
      await expect(input).toBeDisabled();
    await noScriptPage.close();
  }
  console.log(
    "Production auth pages: 24 hydrated page-shell checks, 8 preview 404/no-fixture checks and 4 no-JS credential-safety checks passed at four viewports.",
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
}
