/**
 * Failure detail for logs.
 *
 * The extraction service already keeps its error detail free of source text: it
 * reports positions (`items[0].evidence[1]`) and machine codes, never quotes or
 * provider text. That detail is what makes a validation failure diagnosable —
 * without it a rejection only says "VALIDATION" and the operator has to
 * reconstruct the provider call by hand to learn which item failed.
 *
 * It is still capped here: an unexpected upstream shape must not be able to
 * write an unbounded log line, and a caller must not be able to smuggle
 * free-form text through a field value.
 */

const MAX_FIELDS = 8;
const MAX_VALUES_PER_FIELD = 4;
const MAX_CHARS = 96;

export function boundedFailureDetail(
  fields: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!fields) return undefined;
  // Null prototype: a key named `__proto__` must land as an ordinary entry
  // instead of silently vanishing into the prototype chain.
  const detail: Record<string, string[]> = Object.create(null);
  for (const [key, values] of Object.entries(fields).slice(0, MAX_FIELDS)) {
    if (!Array.isArray(values)) continue;
    // Truncated keys could collide; merge rather than overwrite so no position
    // is silently dropped.
    const boundedKey = key.slice(0, MAX_CHARS);
    const boundedValues = values
      .slice(0, MAX_VALUES_PER_FIELD)
      .map((value) => String(value).slice(0, MAX_CHARS));
    detail[boundedKey] = [...(detail[boundedKey] ?? []), ...boundedValues];
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}
