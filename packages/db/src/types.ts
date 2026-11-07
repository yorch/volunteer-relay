import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.ts";

// The concrete Drizzle database bound to this package's schema.
export type Database = NodePgDatabase<typeof schema>;
