import { randomUUID } from "node:crypto";
import {
  createDatabase,
  provisionOrganization,
} from "../packages/db/src/index.ts";

const usage =
  "Usage: node scripts/provision-organization.ts --email <verified account email> --name <organization name> --slug <new slug> --timezone <IANA timezone>";
function parseArguments(args: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set(["--email", "--name", "--slug", "--timezone"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      !allowed.has(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(usage);
    values.set(key, value);
  }
  if (values.size !== allowed.size) throw new Error(usage);
  const email = (values.get("--email") ?? "").trim().toLowerCase();
  const name = (values.get("--name") ?? "").trim();
  const slug = values.get("--slug") ?? "";
  const timezone = values.get("--timezone") ?? "";
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    name.length < 1 ||
    name.length > 200 ||
    /[\r\n]/.test(name) ||
    slug.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    timezone.length > 100 ||
    !timezone.trim() ||
    timezone !== timezone.trim()
  )
    throw new Error("Invalid organization or account input");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Invalid timezone");
  }
  return { email, name, slug, timezone };
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { db, close } = createDatabase(url);
  try {
    const result = await db.transaction((tx) =>
      provisionOrganization(
        tx.execute.bind(tx),
        {
          name: input.name,
          slug: input.slug,
          timezone: input.timezone,
          ownerEmail: input.email,
        },
        { correlationId: randomUUID() },
      ),
    );
    // The one place an organization is created is shared with the operator
    // console, so the CLI cannot drift from it. Exit codes and messages stay
    // exactly as documented in docs/provisioning.md.
    if (!result.ok) throw new Error(result.error.message);
    process.stdout.write(
      `${JSON.stringify({ organizationId: result.value.organizationId })}\n`,
    );
  } finally {
    await close();
  }
}
try {
  await main();
} catch (error) {
  // Database errors can contain connection or input details: do not print them.
  const safe =
    error instanceof Error &&
    [
      usage,
      "Invalid organization or account input",
      "Invalid timezone",
      "DATABASE_URL is required",
      "A verified credential account is required",
      "Organization name or slug already exists",
    ].includes(error.message)
      ? error.message
      : "Provisioning failed; check database state before retrying";
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
}
