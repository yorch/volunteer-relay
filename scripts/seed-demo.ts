import { createAuthFromEnvironment } from "../apps/web/lib/auth/auth.ts";
import {
  provisionDemo,
  requireDemoProfile,
} from "../apps/web/lib/auth/demo.ts";
import { seedProductDemo } from "../apps/web/lib/auth/product-demo.ts";
import { parseEnvironment } from "../packages/config/src/index.ts";
import { createDatabase } from "../packages/db/src/index.ts";

let close: (() => Promise<void>) | undefined;
try {
  const args = process.argv.slice(2);
  // Reject ordinary/production invocation before opening a database connection.
  requireDemoProfile(args, process.env);
  if (!process.env.DATABASE_URL || !process.env.ATTACHMENT_ROOT)
    throw new Error(
      "Explicit demo database and private attachment root required",
    );
  const env = parseEnvironment(process.env);
  const connection = createDatabase(env.DATABASE_URL);
  close = connection.close;
  const identities = await provisionDemo(
    { db: connection.db, auth: createAuthFromEnvironment(connection.db) },
    args,
    process.env,
  );
  const product = await seedProductDemo(
    { db: connection.db, attachmentRoot: env.ATTACHMENT_ROOT },
    args,
    process.env,
  );
  console.info("Synthetic demo ready", { identities, product });
} catch {
  console.error(
    "Demo seed refused: check the explicit development/test profile, migrations, private database/storage and fixture conflicts. Existing records were not reset.",
  );
  process.exitCode = 1;
} finally {
  await close?.();
}
