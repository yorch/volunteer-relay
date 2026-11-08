import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>["db"];

// Caller owns pool lifecycle. Domain tables and tenant repositories land with
// P1-02; this slice provides the auth/tenancy schema and its readers.
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

export { and, desc, eq, sql } from "drizzle-orm";
export * from "./migrations.ts";
export * from "./repositories/attachments.ts";
export * from "./repositories/domain.ts";
export * from "./repositories/follow-through.ts";
export * from "./repositories/memberships.ts";
export * from "./repositories/model-budget.ts";
export * from "./repositories/processing.ts";
export * from "./repositories/retention.ts";
export * from "./repositories/sources.ts";
export * as schema from "./schema/index.ts";
export * from "./seed-data.ts";
