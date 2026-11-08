import { expect, it } from "vitest";
import { createRedactionSigner } from "./ledger-signing.ts";

it("signs only the exact source tombstone and refuses tampered tenant/revision/digest", () => {
  const signer = createRedactionSigner(
    "synthetic-retention-key-for-tests-only",
  );
  const record = {
    organizationId: "o",
    sourceId: "s",
    latestRevision: 2,
    sourceDigest: "a".repeat(64),
    redactionId: "r",
    reasonHash: "b".repeat(64),
    redactedAt: "2026-11-08T00:00:00.000Z",
  };
  const signature = signer.sign(record);
  expect(signer.verify({ ...record }, signature)).toBe(true);
  for (const changed of [
    { ...record, organizationId: "other" },
    { ...record, latestRevision: 1 },
    { ...record, sourceDigest: "c".repeat(64) },
  ])
    expect(signer.verify(changed, signature)).toBe(false);
  expect(() => createRedactionSigner("short")).toThrow();
});
