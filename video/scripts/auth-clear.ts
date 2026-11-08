import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { log, requireNode26 } from "../src/lib/cli.ts";
import { paths } from "../src/lib/env.ts";

/**
 * Delete only the locally generated browser auth states. Application data,
 * generated media and renders are untouched.
 */
function main(): void {
  requireNode26();
  if (!statSync(paths.authDir, { throwIfNoEntry: false })?.isDirectory()) {
    log("No stored auth states to clear.");
    return;
  }
  const entries = readdirSync(paths.authDir).filter((name) =>
    name.endsWith(".json"),
  );
  for (const entry of entries)
    rmSync(join(paths.authDir, entry), { force: true });
  log(
    entries.length
      ? `Removed ${entries.length} stored auth state file(s) from video/.auth/`
      : "No stored auth state files found.",
  );
  log(
    "Revoke the recording sessions in the application and rotate the recording passwords when the recording is finished.",
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `video:auth:clear failed: ${(error as Error).message}\n`,
  );
  process.exitCode = 1;
}
