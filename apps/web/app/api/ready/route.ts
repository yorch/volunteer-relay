import { mkdir, statfs } from "node:fs/promises";
import { parseEnvironment } from "@relay/config";
import { createDatabase, sql } from "@relay/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let opened: ReturnType<typeof createDatabase> | undefined;
export async function GET() {
  try {
    const env = parseEnvironment(process.env);
    opened ??= createDatabase(env.DATABASE_URL);
    await opened.db.execute(sql`select 1 from source_revision limit 1`);
    await opened.db.execute(
      sql`select 1 from organization_audit_event limit 1`,
    );
    await mkdir(env.ATTACHMENT_ROOT, { recursive: true, mode: 0o700 });
    const space = await statfs(env.ATTACHMENT_ROOT);
    if (space.bavail * space.bsize < env.ATTACHMENT_MAX_BYTES * 2)
      throw new Error("Storage capacity");
    return Response.json(
      { status: "ready", runtime: process.versions.node },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
