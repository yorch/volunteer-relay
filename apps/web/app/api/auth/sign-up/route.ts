import { productionHandler } from "../../../../lib/auth-http/production.ts";
export const runtime = "nodejs";
export const POST = productionHandler("signUp");

// Every Next method reaches the factory guard; only the declared operation runs.
export const GET = POST;
export const PUT = POST;
export const PATCH = POST;
export const DELETE = POST;
export const HEAD = POST;
export const OPTIONS = POST;
