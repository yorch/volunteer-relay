import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, writePrivateBytes } from "./cli.ts";
import { parseEnvFile } from "./env.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-video-cli-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("private binary writes", () => {
  it("writes provider audio bytes unchanged", () => {
    const path = join(tempDir(), "S01.mp3");
    const bytes = Uint8Array.from([0x49, 0x44, 0x33, 0xff, 0xfb, 0x90, 0x00]);
    writePrivateBytes(path, bytes);
    expect([...readFileSync(path)]).toEqual([...bytes]);
    if (process.platform !== "win32")
      expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("argument parsing", () => {
  it("keeps flags and positionals apart", () => {
    const args = parseArgs(["--scene", "S04", "--draft", "--out=x.mp4"]);
    expect(args.positional).toEqual([]);
    expect(args.flags.scene).toBe("S04");
    expect(args.flags.draft).toBe(true);
    expect(args.flags.out).toBe("x.mp4");
  });
});

describe("environment file parsing", () => {
  it("handles quoted values with trailing comments", () => {
    const values = parseEnvFile('VIDEO_OWEN_PASSWORD="abc123" # note\n');
    expect(values.VIDEO_OWEN_PASSWORD).toBe("abc123");
  });

  it("strips unquoted trailing comments without eating spaces in values", () => {
    const values = parseEnvFile(
      "VIDEO_BASE_URL=http://127.0.0.1:3300 # local\n",
    );
    expect(values.VIDEO_BASE_URL).toBe("http://127.0.0.1:3300");
  });

  it("refuses malformed quoting instead of storing it literally", () => {
    expect(() => parseEnvFile('VIDEO_OWEN_PASSWORD="abc\n')).toThrow(
      /unterminated quoted value/,
    );
    expect(() => parseEnvFile('VIDEO_OWEN_PASSWORD="abc" trailing\n')).toThrow(
      /unexpected text/,
    );
  });

  it("keeps blank placeholders as empty strings", () => {
    expect(parseEnvFile("VIDEO_OWEN_PASSWORD=\n").VIDEO_OWEN_PASSWORD).toBe("");
  });
});
