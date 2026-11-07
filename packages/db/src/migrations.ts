import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./types.ts";

// Single source for the migrations directory so the CLI, seeds and tests apply
// the same ordered journal.
export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export async function runMigrations(
  db: Database,
  folder: string = migrationsFolder,
): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
