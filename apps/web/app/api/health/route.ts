import { parseEnvironment } from "@relay/config";
export const runtime = "nodejs";
export function GET() {
  parseEnvironment(process.env);
  if (process.versions.node !== "26.11.1")
    return Response.json({ status: "runtime-mismatch" }, { status: 503 });
  return Response.json({
    status: "ok",
    service: "web",
    runtime: process.versions.node,
  });
}
