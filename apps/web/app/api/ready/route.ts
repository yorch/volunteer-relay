import { createBlobStore, type PrivateBlobStore } from "@relay/blob";
import { parseEnvironment } from "@relay/config";
import { createDatabase, sql } from "@relay/db";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let opened: ReturnType<typeof createDatabase> | undefined;
let blobs: PrivateBlobStore | undefined;
export async function GET() {
  try {
    const env = parseEnvironment(process.env);
    opened ??= createDatabase(env.DATABASE_URL);
    blobs ??= createBlobStore(env);
    await opened.db.execute(sql`select 1 from source_revision limit 1`);
    await opened.db.execute(
      sql`select 1 from organization_audit_event limit 1`,
    );
    // Filesystem asserts a writable root and free space; object storage probes
    // the bucket and its deployment marker. Both fail closed.
    await blobs.probe();
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
