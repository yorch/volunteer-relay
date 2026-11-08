import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log, requireNode26, run, writeJson } from "../src/lib/cli.ts";
import { paths, videoRoot } from "../src/lib/env.ts";
import { parseSceneManifest } from "../src/lib/schema.ts";
import { parseTimeline } from "../src/lib/timeline.ts";
import { ensureAccentAudio } from "./lib/accents.ts";
import { readCaptureManifest, readNarrationManifest } from "./lib/assets.ts";
import { mixNarration } from "./lib/audio-mix.ts";
import { resolveBrowserExecutable } from "./lib/browser.ts";
import { buildRenderProps } from "./lib/props-build.ts";

/**
 * Open Remotion Studio with the measured timeline so the composition can be
 * scrubbed before rendering. Missing assets show an explicit placeholder.
 */

const REMOTION_CLI = join(
  videoRoot,
  "node_modules/@remotion/cli/remotion-cli.js",
);

function main(): void {
  requireNode26();
  if (!existsSync(paths.timeline))
    throw new Error("No timeline manifest. Run bun run video:timeline first.");
  const manifest = parseSceneManifest(
    JSON.parse(readFileSync(paths.scenes, "utf8")),
  );
  const timeline = parseTimeline(
    JSON.parse(readFileSync(paths.timeline, "utf8")),
  );
  const narration = readNarrationManifest();
  const props = buildRenderProps({
    manifest,
    timeline,
    captures: readCaptureManifest(),
    narration,
    mode: "full",
  });
  ensureAccentAudio();
  const mix = narration ? mixNarration(narration) : null;
  if (mix) {
    props.narrationFiles = mix.files;
    props.assets.narration = true;
  }
  const propsPath = `${paths.generated}/preview-props.json`;
  writeJson(propsPath, props);
  log(
    `Preview: ${timeline.totalSeconds.toFixed(2)}s, ${timeline.scenes.length} scenes`,
  );
  log(
    `Narration: ${timeline.narrationSource}; capture origin: ${props.captureOrigin}`,
  );
  const browser = resolveBrowserExecutable();
  const result = run(
    process.execPath,
    [
      REMOTION_CLI,
      "studio",
      "src/Root.tsx",
      `--props=${propsPath}`,
      "--public-dir=generated",
      ...(browser ? [`--browser-executable=${browser}`] : []),
    ],
    { cwd: videoRoot },
  );
  if (result.status !== 0)
    throw new Error(`Remotion Studio failed: ${result.stderr.trim()}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`video:preview failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
