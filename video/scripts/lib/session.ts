import { chmodSync } from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "@playwright/test";
import { ensureDir } from "../../src/lib/cli.ts";
import { paths } from "../../src/lib/env.ts";
import {
  assertOriginAllowed,
  type CaptureTarget,
} from "../../src/lib/target.ts";

/**
 * Unrecorded authentication. No screenshot, video, trace or HAR is enabled here
 * and auth responses are never logged. Storage state is written 0600 under the
 * ignored `video/.auth/` directory.
 */

export interface RoleCredentials {
  role: string;
  email: string;
  password: string;
  organizationId: string;
}

export function storageStatePath(role: string): string {
  return join(paths.authDir, `${role}.json`);
}

export async function withBrowser<T>(
  fn: (browser: Browser) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

export async function authenticate(
  browser: Browser,
  target: CaptureTarget,
  credentials: RoleCredentials,
): Promise<{ organizationId: string; url: string }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Recording surfaces stay off: a failed login must not leave artifacts.
    ignoreHTTPSErrors: false,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${target.baseUrl}/sign-in`, {
      waitUntil: "domcontentloaded",
    });
    assertOriginAllowed(page.url(), target.allowedOrigin);
    await page.locator('input[name="email"]').fill(credentials.email);
    await page.locator('input[name="password"]').fill(credentials.password);
    await Promise.all([
      page.waitForURL((url) => url.pathname !== "/sign-in", {
        timeout: 30_000,
      }),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    assertOriginAllowed(page.url(), target.allowedOrigin);
    if (new URL(page.url()).pathname === "/sign-in")
      throw new Error(`Sign-in was rejected for the ${credentials.role} role`);

    await page.goto(`${target.baseUrl}/account`, {
      waitUntil: "domcontentloaded",
    });
    assertOriginAllowed(page.url(), target.allowedOrigin);
    const switcher = page.locator('select[name="organizationId"]');
    if (await switcher.count()) {
      const values = await switcher
        .locator("option")
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value),
        );
      if (!values.includes(credentials.organizationId))
        throw new Error(
          `The ${credentials.role} identity is not a member of ${credentials.organizationId}`,
        );
      await switcher.selectOption(credentials.organizationId);
      await Promise.all([
        page.waitForURL((url) => url.pathname === "/workspace", {
          timeout: 30_000,
        }),
        page.getByRole("button", { name: "Switch organization" }).click(),
      ]);
    }

    await page.goto(`${target.baseUrl}/workspace/inbox`, {
      waitUntil: "domcontentloaded",
    });
    assertOriginAllowed(page.url(), target.allowedOrigin);
    const snapshot = await page.request.get(
      `${target.baseUrl}/api/product/workspace`,
      { headers: { accept: "application/json" } },
    );
    // A report-reader scoped to a second tenant legitimately receives FORBIDDEN
    // from the private workspace projection; that refusal is itself the boundary
    // proof, so it is only accepted for the multi-organization check.
    const forbiddenForReader =
      snapshot.status() === 403 && credentials.role === "multi-organization";
    if (!snapshot.ok() && !forbiddenForReader)
      throw new Error(
        `Signed-in workspace request failed with HTTP ${snapshot.status()}`,
      );
    if (snapshot.ok()) {
      const body = (await snapshot.json()) as {
        ok?: boolean;
        value?: { organization?: { organizationId?: string; role?: string } };
      };
      const organizationId = body.value?.organization?.organizationId;
      if (!body.ok || organizationId !== credentials.organizationId)
        throw new Error(
          `Session resolved organization ${String(organizationId)}, expected ${credentials.organizationId}`,
        );
    }

    ensureDir(paths.authDir);
    const organizationId = credentials.organizationId;
    const statePath = storageStatePath(credentials.role);
    await context.storageState({ path: statePath });
    try {
      chmodSync(statePath, 0o600);
    } catch {
      // Best effort; the directory is ignored either way.
    }
    return { organizationId, url: page.url() };
  } finally {
    await context.close();
  }
}

export async function newRecordingContext(
  browser: Browser,
  target: CaptureTarget,
  role: string,
): Promise<BrowserContext> {
  const storageState = storageStatePath(role);
  assertOriginAllowed(target.baseUrl, target.allowedOrigin);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    storageState,
    ignoreHTTPSErrors: false,
    recordVideo: { dir: paths.captures, size: { width: 1920, height: 1080 } },
  });
  return context;
}

export async function openPage(
  context: BrowserContext,
  target: CaptureTarget,
  route: string,
): Promise<Page> {
  const page = await context.newPage();
  const url = target.baseUrl + route;
  assertOriginAllowed(url, target.allowedOrigin);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  return page;
}
