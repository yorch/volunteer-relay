import { existsSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import {
  ensureDir,
  gitIgnored,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
  run,
  writePrivate,
} from "../src/lib/cli.ts";
import { loadEnv, parseEnvFile, paths, repoRoot } from "../src/lib/env.ts";
import { identityForRole, loadScenario } from "../src/lib/scenario.ts";
import { resolveTarget } from "../src/lib/target.ts";
import { authenticate, withBrowser } from "./lib/session.ts";

/**
 * Provision or verify the recording identities through existing authorized
 * tooling. Hosted provisioning never creates accounts from this script: the
 * operator creates them through the supported auth flow, and this command only
 * verifies that the supplied credentials work and resolve the right tenant.
 */

const LOCAL_DEMO_PASSWORD = "Public-Synthetic-Demo-Only-2026!";
const RECORDING_ROLES = [
  "owner",
  "coordinator",
  "volunteer",
  "report-reader",
  "multi-organization",
] as const;

function localDemoSeed(): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEMO_MODE: "true",
    NODE_ENV: "development",
  };
  if (!env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL must point at the dedicated local recording database before provisioning",
    );
  if (!env.ATTACHMENT_ROOT)
    throw new Error(
      "ATTACHMENT_ROOT must point at a private writable directory for demo photo bytes",
    );
  log(
    "Provisioning the synthetic demo identities in the local recording database…",
  );
  const result = run(
    process.execPath,
    ["apps/web/lib/auth/demo-cli.ts", "--demo"],
    { cwd: repoRoot, env },
  );
  if (result.status !== 0)
    throw new Error(
      `Local demo provisioning failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  log(result.stdout.trim());
}

function storeMissingPasswords(
  roles: ReadonlyArray<(typeof RECORDING_ROLES)[number]>,
  password: string,
): string[] {
  if (!gitIgnored(repoRoot, "video/.env.local"))
    throw new Error(
      "video/.env.local is not ignored by git; refusing to write credentials",
    );
  const current = existsSync(paths.envLocal)
    ? readFileSync(paths.envLocal, "utf8")
    : "";
  const values = parseEnvFile(current);
  const appended: string[] = [];
  const variables: string[] = [];
  for (const role of roles) {
    if (role === "multi-organization") continue;
    const scenario = loadScenario(paths.scenario);
    const identity = identityForRole(
      scenario,
      role as "coordinator" | "owner" | "volunteer" | "report-reader",
    );
    if (values[identity.envPassword]) continue;
    if (current.includes(`${identity.envPassword}=`)) continue;
    appended.push(
      `${identity.envPassword}=${password}`,
      `${identity.envEmail}=${identity.email}`,
    );
    variables.push(identity.envPassword);
  }
  if (appended.length === 0) return [];
  ensureDir(paths.videoRoot);
  writePrivate(
    paths.envLocal,
    `${current.trimEnd()}\n\n# Synthetic demo recording identities (public demo-only password)\n${appended.join("\n")}\n`,
  );
  return variables;
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const target = resolveTarget(env);
  const scenario = loadScenario(paths.scenario);

  log(
    `Scenario ${scenario.scenarioId} · target ${target.baseUrl} (${target.mode})`,
  );
  if (args.flags["generate-missing"]) {
    log(
      "Per-account generated passwords require a scripted seed that accepts a password per identity; the shipped demo profile uses its documented public demo password. Record this as a seed gap instead of weakening the policy.",
    );
  }

  if (target.mode === "local") {
    localDemoSeed();
    const written = storeMissingPasswords(RECORDING_ROLES, LOCAL_DEMO_PASSWORD);
    if (written.length)
      log(
        `Stored ${written.length} missing credential value(s) in video/.env.local (0600)`,
      );
  } else {
    log(
      "Hosted mode: create or invite the recording identities through the supported auth flow, then supply their passwords in video/.env.local. No account is created by this command.",
    );
  }

  const refreshed = loadEnv();
  await withBrowser(async (browser) => {
    for (const role of RECORDING_ROLES) {
      if (role === "multi-organization") continue;
      const identity = identityForRole(
        scenario,
        role as "coordinator" | "owner" | "volunteer" | "report-reader",
      );
      const email = refreshed[identity.envEmail] ?? identity.email;
      const password = refreshed[identity.envPassword];
      if (!password) {
        log(`  ${role}: MISSING ${identity.envPassword}; not verified`);
        continue;
      }
      const organizationId =
        identity.organization === "primary"
          ? scenario.primaryOrganization.id
          : scenario.secondaryOrganization.id;
      try {
        await authenticate(browser, target, {
          role,
          email,
          password,
          organizationId,
        });
        log(`  ${role}: verified in ${organizationId}`);
      } catch (error) {
        log(`  ${role}: FAILED (${(error as Error).message})`);
        process.exitCode = 1;
      }
    }
  });

  const isolation = scenario.identities.find(
    (identity) => identity.role === "multi-organization",
  );
  if (isolation) {
    const email = refreshed[isolation.envEmail] ?? isolation.email;
    const password = refreshed[isolation.envPassword];
    if (!password) {
      log(
        `  isolation check: MISSING ${isolation.envPassword}; organization-boundary check not run`,
      );
    } else {
      const browser = await chromium.launch();
      try {
        const organizationId = scenario.secondaryOrganization.id;
        await authenticate(browser, target, {
          role: "multi-organization",
          email,
          password,
          organizationId,
        });
        log(
          `  isolation check: verified second-tenant session in ${organizationId}`,
        );
      } finally {
        await browser.close();
      }
    }
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:provision failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
