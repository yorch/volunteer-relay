import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Locate a Chrome/Chromium binary for Remotion. A locally cached Playwright
 * browser avoids an implicit download; if none is found Remotion fetches its
 * own browser on first use. Set REMOTION_BROWSER_EXECUTABLE to override.
 */
export function resolveBrowserExecutable(): string | null {
  const override = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (override && existsSync(override)) return override;
  const roots = [
    join(homedir(), "Library", "Caches", "ms-playwright"),
    join(homedir(), ".cache", "ms-playwright"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      const base = join(root, entry);
      const binaries = [
        join(base, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
        join(base, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
        join(base, "chrome-headless-shell-linux64", "chrome-headless-shell"),
        join(base, "chrome-headless-shell-win64", "chrome-headless-shell.exe"),
      ];
      for (const binary of binaries)
        if (existsSync(binary) && statSync(binary).isFile())
          candidates.push(binary);
    }
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      const base = join(root, entry);
      const binaries = [
        join(
          base,
          "chrome-mac",
          "Chromium.app",
          "Contents",
          "MacOS",
          "Chromium",
        ),
        join(base, "chrome-linux", "chrome"),
        join(base, "chrome-win", "chrome.exe"),
      ];
      for (const binary of binaries)
        if (existsSync(binary) && statSync(binary).isFile())
          candidates.push(binary);
    }
  }
  return candidates.sort().at(-1) ?? null;
}
