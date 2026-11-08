import { productionHandler } from "../../../../lib/auth-http/production.ts";
export const runtime = "nodejs";
export const GET = productionHandler("invitations");

// Every Next method reaches the factory guard; only the declared operation runs.
export const POST = GET;
export const PUT = GET;
export const PATCH = GET;
export const DELETE = GET;
export const HEAD = GET;
export const OPTIONS = GET;
