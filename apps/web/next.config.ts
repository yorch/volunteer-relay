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

// Next.js App Router streams inline bootstrap scripts, so a strict script-src
// would need per-request nonces from a proxy. Until then the policy keeps
// 'unsafe-inline' for scripts/styles and confines everything else to this
// origin: no plugins, no framing, no foreign base or form targets.
// The phase (not NODE_ENV, which `next dev` has not set when this file is
// evaluated) decides whether the policy also admits what React Refresh and
// HMR need.
function headersFor(development: boolean, production: boolean) {
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    {
      key: "Permissions-Policy",
      value:
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    // Production is served over HTTPS by the host proxy; browsers ignore HSTS
    // on plain-HTTP local production checks.
    ...(production
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
        ]
      : []),
  ];
}

// Next's documented phase names (next/constants), compared as literals so this
// file loads without importing Next's runtime.
const PHASE_DEVELOPMENT_SERVER = "phase-development-server";
const PHASE_PRODUCTION_BUILD = "phase-production-build";
const PHASE_PRODUCTION_SERVER = "phase-production-server";

export default function config(phase: string): NextConfig {
  const securityHeaders = headersFor(
    phase === PHASE_DEVELOPMENT_SERVER,
    phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER,
  );
  return {
    distDir,
    poweredByHeader: false,
    async headers() {
      return [{ source: "/:path*", headers: securityHeaders }];
    },
    output: "standalone",
    outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
    typedRoutes: true,
  };
}
