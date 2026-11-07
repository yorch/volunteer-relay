import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, sql } from "../../../packages/db/src/index.ts";
import { openTestDatabase } from "../auth/support.ts";

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  const opened = await openTestDatabase();
  db = opened.db;
  close = opened.close;
});

afterAll(async () => {
  await close();
});

// Regeneration guard for a tooling limitation: Drizzle Kit 0.31.11 cannot express
// a column-specific composite SET NULL, so migration 0001 carries a hand-
// corrected `ON DELETE SET NULL (current_membership_id)`. If that SQL is ever
// regenerated into a plain SET NULL, deleting a membership would also try to
// null organization_id and fail, so this catalog assertion pins the exact shape.
describe("source_author live-pointer delete action", () => {
  it("clears only current_membership_id when the member row is deleted", async () => {
    const constraint = await db.execute(
      sql`select c.conname,
                 c.contype,
                 c.confdeltype,
                 coalesce(
                   (
                     select array_agg(a.attname::text order by a.attname::text)
                     from unnest(c.confdelsetcols) as cols(attnum)
                     join pg_attribute a
                       on a.attrelid = c.conrelid
                      and a.attnum = cols.attnum
                   ),
                   '{}'::text[]
                 ) as cleared_columns
          from pg_constraint c
          where c.conname = 'source_author_current_membership_fk'`,
    );

    expect(constraint.rows).toHaveLength(1);
    const row = constraint.rows[0] as {
      contype: string;
      confdeltype: string;
      cleared_columns: string[];
    };
    // Foreign key with ON DELETE SET NULL.
    expect(row.contype).toBe("f");
    expect(row.confdeltype).toBe("n");
    // Exactly the nullable live pointer is cleared; organization_id never is.
    expect(row.cleared_columns).toEqual(["current_membership_id"]);
    expect(row.cleared_columns).not.toContain("organization_id");
  });
});
