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
      `process.stdout.write((await import(${JSON.stringify(config)})).default("phase-development-server").distDir)`,
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

describe("security headers", () => {
  async function headersFor(phase: string) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const c = (await import(${JSON.stringify(config)})).default(${JSON.stringify(phase)});` +
          "process.stdout.write(JSON.stringify(await c.headers()))",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const [rule] = JSON.parse(result.stdout) as Array<{
      headers: Array<{ key: string; value: string }>;
    }>;
    return new Map(rule?.headers.map((h) => [h.key, h.value]));
  }
  it("never allows framing, plugins or foreign form targets", async () => {
    for (const phase of [
      "phase-development-server",
      "phase-production-server",
    ]) {
      const csp = (await headersFor(phase)).get("Content-Security-Policy");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'self'");
    }
  });
  it("admits eval and websockets only for the development server", async () => {
    const dev = (await headersFor("phase-development-server")).get(
      "Content-Security-Policy",
    );
    const prod = (await headersFor("phase-production-server")).get(
      "Content-Security-Policy",
    );
    expect(dev).toContain("'unsafe-eval'");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(prod).not.toContain("ws:");
  });
  it("sends HSTS only for production phases", async () => {
    expect(
      (await headersFor("phase-development-server")).has(
        "Strict-Transport-Security",
      ),
    ).toBe(false);
    expect(
      (await headersFor("phase-production-build")).has(
        "Strict-Transport-Security",
      ),
    ).toBe(true);
  });
});
