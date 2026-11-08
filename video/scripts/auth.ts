import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  gitCommit,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
} from "../src/lib/cli.ts";
import { loadEnv, paths, repoRoot } from "../src/lib/env.ts";
import { identityForRole, loadScenario } from "../src/lib/scenario.ts";
import { resolveTarget } from "../src/lib/target.ts";
import { authenticate, storageStatePath, withBrowser } from "./lib/session.ts";

/**
 * Unrecorded authentication for every capture role. Sessions are written under
 * the ignored video/.auth/ directory with 0600 permissions and are never reused
 * across targets.
 */

/** Intentionally public synthetic demo password (apps/web/lib/auth/demo.ts). */
const LOCAL_DEMO_PASSWORD = "Public-Synthetic-Demo-Only-2026!";

const CAPTURE_ROLES = [
  "coordinator",
  "owner",
  "volunteer",
  "report-reader",
] as const;

function credentialsFor(
  role: (typeof CAPTURE_ROLES)[number],
  env: Record<string, string | undefined>,
  mode: "hosted" | "local",
): { email: string; password: string; organizationId: string } {
  const scenario = loadScenario(paths.scenario);
  const identity = identityForRole(scenario, role);
  const organizationId =
    identity.organization === "primary"
      ? scenario.primaryOrganization.id
      : scenario.secondaryOrganization.id;
  const email = env[identity.envEmail] ?? identity.email;
  const password = env[identity.envPassword];
  if (!password && mode === "hosted")
    throw new Error(
      `${identity.envPassword} is required for hosted ${role} authentication`,
    );
  return {
    email,
    password: password ?? LOCAL_DEMO_PASSWORD,
    organizationId,
  };
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const target = resolveTarget(env);
  const requested =
    typeof args.flags.role === "string" ? args.flags.role : null;
  const roles = requested
    ? CAPTURE_ROLES.filter((role) => role === requested)
    : [...CAPTURE_ROLES];
  if (requested && roles.length === 0)
    throw new Error(
      `Unknown role ${requested}; choose one of ${CAPTURE_ROLES.join(", ")}`,
    );

  log(
    `Authenticating ${roles.length} role(s) against ${target.baseUrl} (${target.mode})`,
  );
  await withBrowser(async (browser) => {
    for (const role of roles) {
      const credentials = credentialsFor(role, env, target.mode);
      const result = await authenticate(browser, target, {
        role,
        ...credentials,
      });
      log(
        `  ${role}: signed in, organization ${result.organizationId}, state ${storageStatePath(role).replace(`${repoRoot}/`, "")}`,
      );
    }
  });

  // Prove the stored state works in a fresh context without touching the app.
  const probe = await chromium.launch();
  try {
    for (const role of roles) {
      const path = storageStatePath(role);
      if (!existsSync(path))
        throw new Error(`Missing storage state for ${role}`);
      const context = await probe.newContext({ storageState: path });
      const page = await context.newPage();
      const response = await page.request.get(
        `${target.baseUrl}/api/product/workspace`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok())
        throw new Error(
          `Stored ${role} session is not usable (HTTP ${response.status()})`,
        );
      await context.close();
      log(`  ${role}: stored session reverified`);
    }
  } finally {
    await probe.close();
  }
  log(
    `Capture origin: ${target.originLabel}; app commit ${gitCommit(repoRoot) ?? "unknown"}`,
  );
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:auth failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
