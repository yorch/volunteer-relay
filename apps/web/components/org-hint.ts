/**
 * Deep-link organization hint (`?org=<id>`). The hint is only a selector for
 * the existing select endpoint; the server re-checks live membership.
 * Id shape mirrors `isOrganizationHintId` in packages/notifications (source of
 * truth); duplicated here so the client bundle does not import server code.
 */
export function isOrganizationHintId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value);
}

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
