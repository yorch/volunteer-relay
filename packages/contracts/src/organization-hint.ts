/**
 * Organization deep-link hint helpers (`?org=<id>`). Pure and dependency-free so
 * the server packages and the browser bundle share one implementation. The
 * hint is a selector only, never authority: consumers re-check live membership.
 */

const ORGANIZATION_HINT_PARAM = "org";
const ORGANIZATION_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
function hasUnsafeChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === "\\" || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
const PLACEHOLDER_ORIGIN = "https://relay.invalid";

/** True when the value may be carried as an `org` selector hint. */
export function isOrganizationHintId(value: unknown): value is string {
  return typeof value === "string" && ORGANIZATION_ID_SHAPE.test(value);
}

/**
 * Validates an in-app link. Only /workspace/ paths are accepted and the only
 * permitted query parameter is a single well-formed `org` selector hint. The
 * hint is never authority: consumers must re-check live membership.
 */
export function safeAppPath(path: string): string | null {
  if (
    typeof path !== "string" ||
    !path.startsWith("/workspace/") ||
    path.startsWith("//") ||
    hasUnsafeChar(path) ||
    path.includes("..")
  )
    return null;
  try {
    const parsed = new URL(path, PLACEHOLDER_ORIGIN);
    if (
      parsed.origin !== PLACEHOLDER_ORIGIN ||
      !parsed.pathname.startsWith("/workspace/")
    )
      return null;
    const keys = [...parsed.searchParams.keys()];
    if (keys.some((key) => key !== ORGANIZATION_HINT_PARAM)) return null;
    const hints = parsed.searchParams.getAll(ORGANIZATION_HINT_PARAM);
    if (hints.length > 1) return null;
    if (hints.length === 1 && !isOrganizationHintId(hints[0])) return null;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

/**
 * Returns appPath with `?org=<organizationId>` set (replacing any previous
 * hint, preserving other query/hash), or null when the path or id is invalid.
 */
export function withOrganizationHint(
  appPath: string,
  organizationId: string,
): string | null {
  if (!isOrganizationHintId(organizationId)) return null;
  if (
    typeof appPath !== "string" ||
    !appPath.startsWith("/workspace/") ||
    appPath.startsWith("//") ||
    hasUnsafeChar(appPath) ||
    appPath.includes("..")
  )
    return null;
  try {
    const parsed = new URL(appPath, PLACEHOLDER_ORIGIN);
    if (
      parsed.origin !== PLACEHOLDER_ORIGIN ||
      !parsed.pathname.startsWith("/workspace/")
    )
      return null;
    parsed.searchParams.set(ORGANIZATION_HINT_PARAM, organizationId);
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}
