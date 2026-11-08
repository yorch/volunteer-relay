import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Browser verification serves its own build directory (see scripts/run.mjs) so a
// concurrent build, type generation or development server in `.next` cannot
// reload the app under test. Next still rewrites its ignored `next-env.d.ts` for
// the directory it last served. Any override stays a hidden relative directory.
const distDir = process.env.RELAY_NEXT_DIST_DIR ?? ".next";
if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(distDir))
  throw new Error(
    `RELAY_NEXT_DIST_DIR must be a hidden relative directory name; got ${distDir}`,
  );

const config: NextConfig = {
  distDir,
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  typedRoutes: true,
};
export default config;
