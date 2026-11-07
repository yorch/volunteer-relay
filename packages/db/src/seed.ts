import { createDatabase } from "./index.ts";
import { seedOrganizations } from "./seed-data.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("db:seed: DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = createDatabase(connectionString);
try {
  const summary = await seedOrganizations(db);
  // Synthetic tenants and memberships only; zero credential rows.
  console.info("db:seed: synthetic tenants ready", summary);
} catch (error) {
  console.error(
    "db:seed: failed",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
} finally {
  await close();
}
