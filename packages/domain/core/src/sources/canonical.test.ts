import type { SourceEnvelope } from "@relay/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalDigest,
  canonicalize,
  sourceReceivedEventId,
} from "./canonical.ts";

function envelope(overrides: Partial<SourceEnvelope> = {}): SourceEnvelope {
  return {
    schemaVersion: 1,
    organizationId: "tidepath",
    sourceId: "source-01",
    revision: 1,
    channel: "import",
    channelIdentity: "synthetic-tidepath",
    externalMessageId: "1",
    idempotencyKey: "tidepath:1",
    author: { externalIdentity: "Mira", membershipId: "tidepath-mira" },
    occurredAt: "2026-11-04T15:00:00Z",
    receivedAt: "2026-11-04T15:01:00Z",
    timezone: "America/New_York",
    text: "Mira and Sol visited household T-01 for 60 minutes.",
    attachments: [],
    replyToSourceId: null,
    replacesRevision: null,
    original: {
      mediaType: "text/plain",
      payload: "Mira and Sol visited household T-01 for 60 minutes.",
    },
    ...overrides,
  };
}

describe("canonical digest", () => {
  it("ignores object property order", () => {
    const source = envelope();
    const reordered = {
      original: source.original,
      replacesRevision: null,
      replyToSourceId: null,
      attachments: [],
      text: source.text,
      timezone: source.timezone,
      receivedAt: source.receivedAt,
      occurredAt: source.occurredAt,
      author: {
        membershipId: "tidepath-mira",
        externalIdentity: "Mira",
      },
      idempotencyKey: source.idempotencyKey,
      externalMessageId: source.externalMessageId,
      channelIdentity: source.channelIdentity,
      channel: source.channel,
      revision: 1,
      sourceId: source.sourceId,
      organizationId: source.organizationId,
      schemaVersion: 1,
    } as SourceEnvelope;

    expect(canonicalDigest(reordered)).toBe(canonicalDigest(source));
  });

  it("changes when the received timestamp changes", () => {
    expect(
      canonicalDigest(envelope({ receivedAt: "2026-11-04T15:02:00Z" })),
    ).not.toBe(canonicalDigest(envelope()));
  });

  it("changes when the original payload changes", () => {
    const changed = envelope({
      original: { mediaType: "text/plain", payload: "different bytes" },
    });
    expect(canonicalDigest(changed)).not.toBe(canonicalDigest(envelope()));
  });

  it("keeps attachment order significant", () => {
    const attachment = (id: string) => ({
      id,
      organizationId: "tidepath",
      storageKey: `private/${id}`,
      sha256: "a".repeat(64),
      mimeType: "image/png" as const,
      bytes: 10,
    });
    const forward = envelope({
      attachments: [attachment("a"), attachment("b")],
    });
    const reverse = envelope({
      attachments: [attachment("b"), attachment("a")],
    });
    expect(canonicalDigest(forward)).not.toBe(canonicalDigest(reverse));
  });

  it("produces a stable event id per revision", () => {
    expect(sourceReceivedEventId("tidepath", "source-01", 1)).toBe(
      sourceReceivedEventId("tidepath", "source-01", 1),
    );
    expect(sourceReceivedEventId("tidepath", "source-01", 1)).not.toBe(
      sourceReceivedEventId("tidepath", "source-01", 2),
    );
    expect(sourceReceivedEventId("tidepath", "source-01", 1)).not.toBe(
      sourceReceivedEventId("harbor", "source-01", 1),
    );
  });

  it("rejects non-JSON values instead of silently dropping them", () => {
    expect(() => canonicalize({ at: undefined, value: "kept" })).not.toThrow();
    expect(canonicalize({ at: undefined, value: "kept" })).toEqual({
      value: "kept",
    });
    expect(() => canonicalize(() => null)).toThrow(TypeError);
  });
});
