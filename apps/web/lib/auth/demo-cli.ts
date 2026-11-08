import { createDatabase } from "@relay/db";
import { createAuthFromEnvironment } from "./auth.ts";
import { provisionDemo, requireDemoProfile } from "./demo.ts";

// Explicit invocation (Node 26.11.1):
// DEMO_MODE=true NODE_ENV=development node --env-file=.env.local apps/web/lib/auth/demo-cli.ts --demo
// Public synthetic emails: demo-{owner,coordinator,volunteer,reader,multi}@example.invalid
// Intentionally public password is documented in demo.ts. Never print it here.
let close: (() => Promise<void>) | undefined;
try {
  requireDemoProfile(process.argv.slice(2), process.env);
  if (!process.env.DATABASE_URL) throw new Error("Missing configuration");
  const connection = createDatabase(process.env.DATABASE_URL);
  close = connection.close;
  const auth = createAuthFromEnvironment(connection.db);
  const summary = await provisionDemo(
    { db: connection.db, auth },
    process.argv.slice(2),
    process.env,
  );
  console.info("Synthetic demo profile ready", summary);
} catch {
  console.error(
    "Demo provisioning refused; check explicit profile, configuration and conflicts",
  );
  process.exitCode = 1;
} finally {
  await close?.();
}
