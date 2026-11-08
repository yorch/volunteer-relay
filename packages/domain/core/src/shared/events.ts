import { createHash } from "node:crypto";
import { canonicalize } from "../sources/canonical.ts";

// Stable id for one aggregate event, so a replay never mints a new event. The
// components are JSON-encoded because opaque ids may contain separators.
export function domainEventId(
  organizationId: string,
  type: "source.received" | "ledger.changed" | "need.changed",
  aggregateId: string,
  aggregateRevision: number,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([organizationId, type, aggregateId, aggregateRevision]),
    )
    .digest("hex");
  return `evt:${digest}`;
}

// Canonical digest of a validated command under its type. Comparing digests is
// how an idempotent replay is distinguished from a changed command under the
// same idempotency key.
export function commandDigest(commandType: string, command: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ commandType, command })))
    .digest("hex");
}
