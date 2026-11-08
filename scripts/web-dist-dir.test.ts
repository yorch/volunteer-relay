import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The browser server must not share apps/web/.next with builds, type generation
// or a development server. The config is loaded in a child process so root type
// checking does not import Next's global environment augmentation.
const config = fileURLToPath(
  new URL("../apps/web/next.config.ts", import.meta.url),
);
function load(value: string | undefined) {
  const env = { ...process.env };
  if (value === undefined) delete env.RELAY_NEXT_DIST_DIR;
  else env.RELAY_NEXT_DIST_DIR = value;
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.stdout.write((await import(${JSON.stringify(config)})).default.distDir)`,
    ],
    { env, encoding: "utf8" },
  );
}

describe("browser build directory", () => {
  it("defaults to the shared .next directory", () => {
    const result = load(undefined);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(".next");
  });
  it("honours a hidden relative override", () => {
    const result = load(".next-e2e");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(".next-e2e");
  });
  it.each(["", ".", "..", "../escape", "plain", "/absolute", "a/b"])(
    "rejects %j instead of serving an unintended directory",
    (value) => {
      const result = load(value);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/hidden relative directory/);
    },
  );
  it("starts the browser server in the isolated directory", () => {
    const server = readFileSync(new URL("./run.mjs", import.meta.url), "utf8");
    expect(server).toContain('RELAY_NEXT_DIST_DIR: ".next-e2e"');
  });
});
