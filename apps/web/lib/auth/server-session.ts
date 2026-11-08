import { parseEnvironment } from "@relay/config";
import { createDatabase } from "@relay/db";
import { headers } from "next/headers";
import { createProductionAuth } from "../mail/production.ts";

/**
 * The SDK resolves absent, expired and malformed cookies to no session, so the
 * only trustworthy signal is a user id on the response (see the same read in
 * `session.ts`). Kept pure so the mapping is testable without Next or a
 * database.
 */
export function sessionPresent(
  result:
    | { response?: { user?: { id?: string } | null } | null }
    | null
    | undefined,
): boolean {
  return Boolean(result?.response?.user?.id);
}

type ServerAuth = ReturnType<typeof createProductionAuth>;
let cached: ServerAuth | undefined;

function serverAuth(): ServerAuth | undefined {
  if (cached) return cached;
  try {
    const env = parseEnvironment(process.env);
    const { db } = createDatabase(env.DATABASE_URL);
    cached = createProductionAuth(db);
    return cached;
  } catch {
    // A build-time prerender or a misconfigured deployment reads as signed out
    // rather than failing the page; the API routes still report the real error.
    return undefined;
  }
}

/**
 * Authoritative signed-in check for server components. Reading request headers
 * opts these routes out of static prerendering, which is the point: a cached
 * shell cannot know who is asking.
 */
export async function isSignedIn(): Promise<boolean> {
  // Await headers() first and unconditionally: this call is what opts the route
  // out of static prerendering. Initializing the auth service before it could
  // throw — a build with no BETTER_AUTH_SECRET, for instance — and return early,
  // leaving a prerendered signed-out page behind that no runtime secret fixes.
  const requestHeaders = await headers();
  const auth = serverAuth();
  if (!auth) return false;
  try {
    return sessionPresent(
      await auth.api.getSession({
        headers: requestHeaders,
        returnHeaders: true,
        // Presentation only. Renewing here would extend the database session
        // while the Set-Cookie it emits is discarded, so the browser cookie
        // would keep its old expiry and every visit would advance the server
        // side without the client. Renewal belongs to the handlers that forward
        // those headers.
        query: { disableRefresh: true },
      }),
    );
  } catch {
    return false;
  }
}
