import { chromium } from "@playwright/test";
import {
  gitCommit,
  log,
  type ParsedArgs,
  parseArgs,
  requireNode26,
  run,
} from "../src/lib/cli.ts";
import { loadEnv, paths, repoRoot } from "../src/lib/env.ts";
import {
  compareTotals,
  identityForRole,
  loadExpectedResults,
  loadScenario,
} from "../src/lib/scenario.ts";
import { resolveTarget } from "../src/lib/target.ts";
import { authenticate } from "./lib/session.ts";
import { readTotals } from "./lib/totals.ts";

/**
 * Prepare recording state.
 *
 * hosted (default): verify the recording organization and the authored baseline
 * read-only. Nothing is deleted and nothing is created without the operator.
 *
 * local: run migrations and the synthetic demo seed against a database whose
 * name and marker prove it is the disposable recording database. Destructive
 * resets stay manual and are never triggered by routine preparation.
 */

const LOCAL_MARKER = "relay-video-recording";

function assertLocalDatabase(): string {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(
      "DATABASE_URL must be set to the dedicated recording database in local mode",
    );
  const parsed = new URL(url);
  const database = parsed.pathname.replace(/^\//, "");
  if (!database.endsWith("_video_recording"))
    throw new Error(
      `Refusing local preparation: database "${database}" does not end with _video_recording`,
    );
  if (process.env.VIDEO_LOCAL_DATABASE_MARKER !== LOCAL_MARKER)
    throw new Error(
      `Refusing local preparation: VIDEO_LOCAL_DATABASE_MARKER must be ${LOCAL_MARKER}`,
    );
  const host = parsed.hostname;
  if (!["127.0.0.1", "localhost", "postgres", "::1"].includes(host))
    throw new Error(
      `Refusing local preparation: host ${host} is not a local database`,
    );
  return database;
}

async function verifyBaseline(): Promise<void> {
  const env = loadEnv();
  const target = resolveTarget(env);
  const scenario = loadScenario(paths.scenario);
  const expected = loadExpectedResults(paths.expectedResults);
  const identity = identityForRole(scenario, "coordinator");
  const password = env[identity.envPassword];
  if (!password)
    throw new Error(
      `${identity.envPassword} is required to verify the recording baseline`,
    );
  const browser = await chromium.launch();
  try {
    await authenticate(browser, target, {
      role: "coordinator",
      email: env[identity.envEmail] ?? identity.email,
      password,
      organizationId: scenario.primaryOrganization.id,
    });
    const context = await browser.newContext({
      storageState: `${paths.authDir}/coordinator.json`,
    });
    const page = await context.newPage();
    const observed = await readTotals(page, target, scenario);
    const comparison = compareTotals(expected.baseline, observed);
    await context.close();
    if (!comparison.ok)
      throw new Error(
        `Recording baseline does not match the authored oracle:\n${comparison.mismatches
          .map(
            (m) =>
              `  ${m.field}: expected ${m.expected}, observed ${m.observed}`,
          )
          .join(
            "\n",
          )}\nHosted data is never reset by this command. Seed or accept the state through the operator flow, or record against a fresh local database.`,
      );
    log(
      `Baseline verified: ${observed.approvedMinutes} approved minutes, ${observed.approvedContributions} contributions, ${observed.reviewQueue} awaiting review, ${observed.sources} sources.`,
    );
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  requireNode26();
  const args: ParsedArgs = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const target = resolveTarget(env);
  const scenario = loadScenario(paths.scenario);

  if (args.flags.reset) {
    log(
      "video:prepare does not reset databases. For a local restart only, stop the rehearsal app and recreate the disposable database manually, for example: docker compose -p relay-video exec postgres dropdb -U relay relay_video_recording && createdb relay_video_recording, then re-run migrations and this command with VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording. Hosted data is never reset.",
    );
    return;
  }

  log(`Target: ${target.baseUrl} (${target.mode})`);
  log(
    `Scenario: ${scenario.scenarioId} · organization ${scenario.primaryOrganization.id}`,
  );

  if (target.mode === "local") {
    const database = assertLocalDatabase();
    log(`Local recording database verified: ${database}`);
    const migration = run(process.execPath, ["packages/db/src/migrate.ts"], {
      cwd: repoRoot,
    });
    if (migration.status !== 0)
      throw new Error(`Migrations failed: ${migration.stderr.trim()}`);
    log("Migrations applied.");
    const seed = run(process.execPath, ["scripts/seed-demo.ts", "--demo"], {
      cwd: repoRoot,
      env: { ...process.env, DEMO_MODE: "true", NODE_ENV: "development" },
    });
    if (seed.status !== 0)
      throw new Error(
        `Demo seed failed: ${seed.stderr.trim() || seed.stdout.trim()}`,
      );
    log(seed.stdout.trim());
  } else {
    log(
      "Hosted preparation is non-destructive: verifying existing records only. Routine preparation never deletes hosted data.",
    );
  }

  await verifyBaseline();
  log(`App commit: ${gitCommit(repoRoot) ?? "unknown"}`);
}

await main().catch((error: unknown) => {
  process.stderr.write(`video:prepare failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
