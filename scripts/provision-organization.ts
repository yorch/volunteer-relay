import { randomUUID } from "node:crypto";
import { createDatabase, sql } from "../packages/db/src/index.ts";

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
    const organizationId = randomUUID();
    await db.transaction(async (tx) => {
      const users = await tx.execute(
        sql`select id from "user" where email=${input.email} and email_verified=true for share`,
      );
      const userId = users.rows[0]?.id;
      if (typeof userId !== "string")
        throw new Error("A verified credential account is required");
      const credential = await tx.execute(
        sql`select id from account where user_id=${userId} and provider_id='credential' and password is not null and length(password)>0 for share`,
      );
      if (!credential.rows.length)
        throw new Error("A verified credential account is required");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(lower(${input.name}), 0))`,
      );
      const existing = await tx.execute(
        sql`select 1 from organization where slug=${input.slug} or lower(name)=lower(${input.name})`,
      );
      if (existing.rows.length)
        throw new Error("Organization name or slug already exists");
      await tx.execute(
        sql`insert into organization (id,name,slug,created_at) values (${organizationId},${input.name},${input.slug},now())`,
      );
      await tx.execute(
        sql`insert into member (id,organization_id,user_id,role,created_at) values (${randomUUID()},${organizationId},${userId},'owner',now())`,
      );
      await tx.execute(
        sql`insert into organization_settings (organization_id,revision,timezone,automation_policy,policy_version,routing,fallback_membership_id,ack_minutes,retention_days) values (${organizationId},1,${input.timezone},'review-all','1','{}'::jsonb,null,60,365)`,
      );
    });
    process.stdout.write(`${JSON.stringify({ organizationId })}\n`);
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
