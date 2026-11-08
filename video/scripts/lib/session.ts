import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "@playwright/test";
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

/** Auth state is a credential: private directory, private files, no window. */
function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeStorageState(
  state: Awaited<ReturnType<BrowserContext["storageState"]>>,
  role: string,
): string {
  ensurePrivateDir(paths.authDir);
  const destination = storageStatePath(role);
  const temporary = `${destination}.tmp`;
  rmSync(temporary, { force: true });
  // Create the file private *before* any secret bytes exist in it.
  writeFilePrivate(temporary);
  writeFilePrivate(temporary, JSON.stringify(state, null, 2));
  chmodSync(temporary, 0o600);
  renameSync(temporary, destination);
  chmodSync(destination, 0o600);
  return destination;
}

function writeFilePrivate(path: string, contents = ""): void {
  const file = openSync(path, "w", 0o600);
  try {
    writeFileSync(file, contents, "utf8");
  } finally {
    closeSync(file);
  }
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
): Promise<{ organizationId: string; url: string; statePath: string }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    // Recording surfaces stay off: a failed login must not leave artifacts.
    ignoreHTTPSErrors: false,
  });
  try {
    // Lock the context to the allowed origin before any credential is typed:
    // a cross-origin form action, submit or redirect is aborted, not followed.
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (
        requestUrl.protocol.startsWith("http") &&
        requestUrl.origin !== target.allowedOrigin
      ) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    const page = await context.newPage();
    await page.goto(`${target.baseUrl}/sign-in`, {
      waitUntil: "domcontentloaded",
    });
    assertOriginAllowed(page.url(), target.allowedOrigin);
    const formAction = await page
      .locator("form")
      .first()
      .getAttribute("action", { timeout: 5_000 })
      .catch(() => null);
    if (formAction) {
      const resolved = new URL(formAction, page.url()).origin;
      if (resolved !== target.allowedOrigin)
        throw new Error(
          `Refusing to submit credentials: the sign-in form posts to ${resolved}`,
        );
    }
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

    const organizationId = credentials.organizationId;
    const statePath = writeStorageState(
      await context.storageState(),
      credentials.role,
    );
    return { organizationId, url: page.url(), statePath };
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
  // Capture larger than delivery so a full workspace fits without scrolling,
  // then downscale to 1920x1080 in normalisation. CSS zoom was tried and broke
  // fixed-position chrome; a bigger viewport keeps the layout faithful.
  const context = await browser.newContext({
    viewport: { width: 2560, height: 1440 },
    deviceScaleFactor: 1,
    storageState,
    ignoreHTTPSErrors: false,
    recordVideo: { dir: paths.captures, size: { width: 2560, height: 1440 } },
  });
  return context;
}

/**
 * Visible pointer for captured footage. Playwright's headless mouse has no OS
 * cursor, so a DOM overlay follows the real mouse events we dispatch. It is a
 * presentational overlay tied to genuine actions, never a fake click.
 */
export async function installCursor(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById("__relay_cursor")) return;
    const style = document.createElement("style");
    style.textContent = `
      #__relay_cursor{position:fixed;z-index:2147483647;width:28px;height:28px;border-radius:50%;
        background:rgba(255,255,255,.96);border:2px solid #174f42;box-shadow:0 2px 8px rgba(0,0,0,.35);
        left:-40px;top:-40px;pointer-events:none;transform:translate(-50%,-50%);transition:opacity .2s}
      #__relay_ripple{position:fixed;z-index:2147483646;width:20px;height:20px;border-radius:50%;
        background:rgba(23,108,87,.35);opacity:0;pointer-events:none;transform:translate(-50%,-50%)}`;
    document.head.append(style);
    const cursor = document.createElement("div");
    cursor.id = "__relay_cursor";
    const ripple = document.createElement("div");
    ripple.id = "__relay_ripple";
    document.body.append(ripple, cursor);
    document.addEventListener("mousemove", (event) => {
      cursor.style.left = `${event.clientX}px`;
      cursor.style.top = `${event.clientY}px`;
    });
    document.addEventListener("mousedown", (event) => {
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      ripple.animate(
        [
          { opacity: 0.9, width: "14px", height: "14px" },
          { opacity: 0, width: "72px", height: "72px" },
        ],
        { duration: 420, easing: "ease-out" },
      );
    });
  });
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
  await page.addStyleTag({ content: "*{transition:none!important}" });
  await page.waitForTimeout(150);
  return page;
}
