import { productionHandler } from "../../../../lib/auth-http/production.ts";
export const runtime = "nodejs";
export const POST = productionHandler("signOut");
