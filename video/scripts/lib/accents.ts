import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, run } from "../../src/lib/cli.ts";
import { paths } from "../../src/lib/env.ts";

/**
 * UI accent sounds are synthesised locally with ffmpeg (short sines), so no
 * third-party audio licence applies. They are mixed well under narration.
 */
const ACCENT_DIR = join(paths.generated, "audio");

const RECIPES = {
  click:
    "sine=frequency=1500:duration=0.045,volume=0.35,afade=t=out:st=0.015:d=0.03",
  confirm:
    "sine=frequency=988:duration=0.11,volume=0.3,afade=t=out:st=0.05:d=0.06",
} as const;

export function ensureAccentAudio(): void {
  ensureDir(ACCENT_DIR);
  for (const [name, filter] of Object.entries(RECIPES)) {
    const target = join(ACCENT_DIR, `${name}.mp3`);
    if (existsSync(target)) continue;
    const result = run("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      filter,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "128k",
      target,
    ]);
    if (result.status !== 0)
      throw new Error(
        `Could not synthesise the ${name} accent: ${result.stderr.trim()}`,
      );
  }
}
