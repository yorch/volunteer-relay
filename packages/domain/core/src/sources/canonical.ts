import { createHash } from "node:crypto";
import type { SourceEnvelope } from "@relay/contracts";

// JSON-safe canonical projection type; the digest input is always a validated
// envelope, so anything outside this union is a programming error.
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Deterministic JSON projection: object keys are sorted recursively, arrays keep
 * their given order. Two envelopes with the same values therefore hash equally
 * regardless of property order, while attachment and evidence ordering still
 * matter.
 */
export function canonicalize(value: unknown): CanonicalValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const projection: { [key: string]: CanonicalValue } = {};
    for (const [key, item] of entries) projection[key] = canonicalize(item);
    return projection;
  }
  throw new TypeError("canonicalize: value is not JSON-compatible");
}

// Digest over the validated complete envelope, including receivedAt and the
// original payload. Comparing digests is how a replay is distinguished from a
// changed payload under the same idempotency key.
export function canonicalDigest(source: SourceEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(source)))
    .digest("hex");
}

// Stable id for one source revision event, so a replay never mints a new event.
export function sourceReceivedEventId(
  organizationId: string,
  sourceId: string,
  revision: number,
): string {
  // Unambiguous tuple encoding: opaque IDs may themselves contain separators, so
  // the components are JSON-encoded rather than concatenated.
  const digest = createHash("sha256")
    .update(
      JSON.stringify([organizationId, "source.received", sourceId, revision]),
    )
    .digest("hex");
  return `evt:${digest}`;
}
