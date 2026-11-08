import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./types.ts";

// Single source for the migrations directory so the CLI, seeds and tests apply
// the same ordered journal.
// A filesystem directory, not a web-bundler URL asset dependency.
export const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations",
);

export async function runMigrations(
  db: Database,
  folder: string = migrationsFolder,
): Promise<void> {
  await migrate(db, { migrationsFolder: folder });
}
