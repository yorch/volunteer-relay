import { defineConfig } from "@playwright/test";

if (process.versions.node !== "26.11.1")
  throw new Error("Browser tests require Node 26.11.1");
const port = Number(process.env.PLAYWRIGHT_PORT ?? "3190");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid PLAYWRIGHT_PORT");
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  globalTimeout: 180_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "tablet-1024", use: { viewport: { width: 1024, height: 768 } } },
    {
      name: "mobile-390",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "narrow-320",
      use: {
        viewport: { width: 320, height: 720 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "node scripts/run.mjs e2e:web",
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer:
      !process.env.CI && process.env.PLAYWRIGHT_REUSE_SERVER === "true",
    env: { PLAYWRIGHT_PORT: String(port), NEXT_TELEMETRY_DISABLED: "1" },
  },
});
