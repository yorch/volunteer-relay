import {
  createDatabase,
  type Database,
  runMigrations,
  sql,
} from "../../../packages/db/src/index.ts";

// Integration tests run only against an explicitly separate *_test database.
export function resolveTestDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "TEST_DATABASE_URL is required: integration tests never fall back to DATABASE_URL",
    );

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(new URL(url).pathname).replace(/^\//, "");
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid URL");
  }
  if (!databaseName.endsWith("_test"))
    throw new Error(
      `Refusing to run integration tests against "${databaseName}": the database name must end with _test`,
    );
  if (env.DATABASE_URL && env.DATABASE_URL === url)
    throw new Error(
      "Refusing to run integration tests: TEST_DATABASE_URL must differ from DATABASE_URL",
    );
  return url;
}

export interface TestDatabase {
  db: Database;
  close: () => Promise<void>;
}

export async function openTestDatabase(): Promise<TestDatabase> {
  const { db, close } = createDatabase(resolveTestDatabaseUrl());
  await runMigrations(db);
  return { db, close };
}

// Destructive setup is limited to the verified test database and the auth
// tables added by this slice.
export async function resetAuthTables(db: Database): Promise<void> {
  await db.execute(
    sql`truncate table "invitation", "member", "session", "account", "verification", "organization", "user" restart identity cascade`,
  );
}

export function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export async function expectDatabaseRejection(
  action: () => Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const code = databaseErrorCode(error);
    if (code !== expectedCode)
      throw new Error(
        `Expected database error ${expectedCode}, received ${code ?? "none"}`,
      );
    return;
  }
  throw new Error(
    `Expected database error ${expectedCode}, but the statement succeeded`,
  );
}

export async function countRows(
  db: Database,
  table:
    | "user"
    | "session"
    | "account"
    | "verification"
    | "organization"
    | "member"
    | "invitation",
): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from ${sql.identifier(table)}`,
  );
  const row = result.rows[0] as { count?: number } | undefined;
  return row?.count ?? 0;
}
