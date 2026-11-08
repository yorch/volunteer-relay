import { isOrganizationHintId } from "@relay/contracts";

/**
 * Deep-link organization hint (`?org=<id>`). The hint is only a selector for
 * the existing select endpoint; the server re-checks live membership. The id
 * shape comes from the shared helper in `@relay/contracts` (pure, so safe for
 * the client bundle) and is re-exported for the callers and tests here.
 */
export { isOrganizationHintId };

/**
 * Splits a location search string into the validated hint (if any) and the
 * same query without the `org` parameter. A malformed hint is dropped.
 */
export function splitOrganizationHint(search: string): {
  present: boolean;
  hint: string | undefined;
  rest: string;
} {
  const params = new URLSearchParams(search);
  const raw = params.get("org");
  const present = params.has("org");
  params.delete("org");
  const rest = params.toString();
  return {
    present,
    hint: raw !== null && isOrganizationHintId(raw) ? raw : undefined,
    rest: rest ? `?${rest}` : "",
  };
}
