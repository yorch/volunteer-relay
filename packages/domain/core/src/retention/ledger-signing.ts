import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type RedactionLedgerRecord,
  redactionLedgerRecordSchema,
} from "@relay/contracts";
import { canonicalize } from "../sources/canonical.ts";
export function createRedactionSigner(key: string) {
  if (key.length < 32)
    throw new Error("Retention signing key is not configured");
  const sign = (input: RedactionLedgerRecord) => {
    const r = redactionLedgerRecordSchema.parse(input);
    const payload = JSON.stringify([
      1,
      r.organizationId,
      r.sourceId,
      r.latestRevision,
      r.sourceDigest,
      r.redactionId,
      r.reasonHash,
      r.redactedAt,
    ]);
    return createHmac("sha256", key).update(payload).digest("hex");
  };
  const signManifest = (payload: unknown) =>
    createHmac("sha256", key)
      .update(`manifest:${JSON.stringify(canonicalize(payload))}`)
      .digest("hex");
  return {
    sign,
    signManifest,
    verifyManifest: (payload: unknown, signature: string) => {
      try {
        return (
          /^[a-f0-9]{64}$/.test(signature) &&
          timingSafeEqual(
            Buffer.from(signature, "hex"),
            Buffer.from(signManifest(payload), "hex"),
          )
        );
      } catch {
        return false;
      }
    },
    verify: (record: RedactionLedgerRecord, signature: string) => {
      try {
        if (!/^[a-f0-9]{64}$/.test(signature)) return false;
        return timingSafeEqual(
          Buffer.from(signature, "hex"),
          Buffer.from(sign(record), "hex"),
        );
      } catch {
        return false;
      }
    },
  };
}
