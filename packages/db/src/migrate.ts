import { createDatabase } from "./index.ts";
import { runMigrations } from "./migrations.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("db:migrate: DATABASE_URL is required");
  process.exit(1);
}

const { db, close } = createDatabase(connectionString);
try {
  // Idempotent: already-applied migrations are skipped by the journal.
  await runMigrations(db);
  // Never print the connection string; it may carry credentials.
  console.info("db:migrate: migrations applied");
} catch (error) {
  console.error(
    "db:migrate: failed",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
} finally {
  await close();
}
