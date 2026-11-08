/**
 * Validates a post-sign-in destination taken from `?next=`. Only same-origin
 * absolute paths are accepted: a single leading "/", no protocol-relative
 * "//", no backslashes, no scheme and no control characters. Anything else
 * yields `undefined` so callers fall back to the workspace.
 */
export function safeNextPath(
  raw: string | null | undefined,
): string | undefined {
  if (!raw || raw.length > 512) return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\"))
    return undefined;
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === "\\") return undefined;
  }
  try {
    const base = "http://relay.invalid";
    const target = new URL(raw, base);
    return target.origin === base
      ? `${target.pathname}${target.search}${target.hash}`
      : undefined;
  } catch {
    return undefined;
  }
}

export const defaultDestination = "/workspace";
export function destinationFromSearch(search: string): string {
  return (
    safeNextPath(new URLSearchParams(search).get("next")) ?? defaultDestination
  );
}
