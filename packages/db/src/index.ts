import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
// Caller owns pool lifecycle. Tenant repositories and schema arrive in P1.
export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool), close: () => pool.end() };
}
