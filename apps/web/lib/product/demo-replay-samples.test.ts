import type { SourceEnvelope } from "@relay/contracts";
import { describe, expect, it } from "vitest";
import {
  createDeterministicProvider,
  DETERMINISTIC_MODEL_VERSION,
  DETERMINISTIC_PROMPT_VERSION,
} from "../../../../packages/ai/src/deterministic.ts";
import { createExtractionService } from "../../../../packages/ai/src/service.ts";
import { demoReplayExpected } from "./demo-replay-samples.expected.ts";
import {
  demoReplayOptions,
  demoReplaySampleIds,
  demoReplaySamples,
  findDemoReplaySample,
} from "./demo-replay-samples.ts";

const RECEIVED_AT = "2026-11-05T15:00:00.000Z";
const RECEIPT_DAY = "2026-11-05";

function envelope(id: string, text: string, photo: boolean): SourceEnvelope {
  return {
    schemaVersion: 1,
    organizationId: "org-replay",
    sourceId: `replay:${id}`,
    revision: 1,
    channel: "web",
    channelIdentity: "demo-replay",
    externalMessageId: `replay:${id}`,
    idempotencyKey: `replay:${id}`,
    author: { externalIdentity: "user-demo", membershipId: "member-demo" },
    occurredAt: null,
    receivedAt: RECEIVED_AT,
    timezone: "America/New_York",
    text,
    attachments: photo
      ? [
          {
            id: "photo:sample",
            organizationId: "org-replay",
            storageKey: `ab/${"a".repeat(64)}`,
            sha256: "a".repeat(64),
            mimeType: "image/png",
            bytes: 100,
          },
        ]
      : [],
    replyToSourceId: null,
    replacesRevision: null,
    original: { mediaType: "text/plain", payload: text },
  };
}

describe("demo replay catalog", () => {
  it("holds six to eight uniquely identified, well-formed samples", () => {
    expect(demoReplaySamples.length).toBeGreaterThanOrEqual(6);
    expect(demoReplaySamples.length).toBeLessThanOrEqual(8);
    expect(new Set(demoReplaySampleIds).size).toBe(demoReplaySamples.length);
    expect(new Set(demoReplaySamples.map((sample) => sample.label)).size).toBe(
      demoReplaySamples.length,
    );
    expect(new Set(demoReplaySamples.map((sample) => sample.text)).size).toBe(
      demoReplaySamples.length,
    );
    for (const sample of demoReplaySamples) {
      expect(sample.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(sample.id.length).toBeLessThanOrEqual(100);
      expect(sample.label.trim()).toBe(sample.label);
      expect(sample.label.length).toBeGreaterThan(0);
      expect(sample.scenario.length).toBeGreaterThan(0);
      expect(sample.text.trim().length).toBeGreaterThan(0);
      expect(sample.text.length).toBeLessThanOrEqual(500);
      // Synthetic only: no links, addresses or real-looking contact data.
      expect(sample.text).not.toMatch(/https?:|www\.|@|\+?\d{3}[-\s]\d{3}/);
      expect(findDemoReplaySample(sample.id)).toBe(sample);
    }
  });
  it("covers the required demonstration scenarios", () => {
    expect(demoReplaySampleIds).toEqual(
      expect.arrayContaining([
        "shared-visit-en",
        "spanish-update",
        "unknown-duration",
        "duplicate-visit",
        "correction-90",
        "urgent-need",
        "supplies-photo",
      ]),
    );
    expect(demoReplaySamples.filter((sample) => sample.photo)).toHaveLength(1);
  });
  it("draws the photo without text or people", () => {
    for (const sample of demoReplaySamples) {
      if (!sample.photo) continue;
      expect(sample.photo.svg.startsWith("<svg")).toBe(true);
      expect(sample.photo.svg).not.toMatch(
        /<text|<image|<foreignObject|<script|href=|url\(/i,
      );
      expect(sample.photo.svg).toContain(
        `viewBox="0 0 ${sample.photo.width} ${sample.photo.height}"`,
      );
    }
  });
  it("refuses identifiers outside the catalog and exposes no text in options", () => {
    expect(findDemoReplaySample("custom")).toBeNull();
    expect(findDemoReplaySample(undefined)).toBeNull();
    expect(findDemoReplaySample({ id: "spanish-update" })).toBeNull();
    for (const option of demoReplayOptions())
      expect(Object.keys(option).sort()).toEqual([
        "hasPhoto",
        "id",
        "label",
        "scenario",
      ]);
  });
  it("has an independently authored expectation for every sample", () => {
    expect(Object.keys(demoReplayExpected).sort()).toEqual(
      [...demoReplaySampleIds].sort(),
    );
  });
});

describe("provider-free extraction of the catalog", () => {
  const extraction = createExtractionService({
    provider: createDeterministicProvider(),
    newRunId: () => "run-sample",
    maxAttempts: 1,
  });
  const context = {
    organizationId: "org-replay",
    actor: { kind: "system" as const, service: "worker" as const },
    correlationId: "corr-sample",
  };
  for (const sample of demoReplaySamples) {
    it(`matches the oracle for ${sample.id}`, async () => {
      const expected = demoReplayExpected[sample.id];
      if (!expected) throw new Error("Missing expectation");
      const source = envelope(sample.id, sample.text, sample.photo !== null);
      expect(source.attachments).toHaveLength(expected.attachments);
      const result = await extraction.extract(context, source, {
        model: DETERMINISTIC_MODEL_VERSION,
        prompt: DETERMINISTIC_PROMPT_VERSION,
        policy: "1",
      });
      if (!result.ok) throw new Error(result.error.code);
      const proposal = result.value;
      expect(proposal.items.map((item) => item.kind)).toEqual(
        expected.items.map((item) => item.kind),
      );
      expected.items.forEach((want, index) => {
        const got = proposal.items[index];
        if (!got || got.kind !== want.kind) throw new Error("Kind mismatch");
        if (want.kind === "activity" && got.kind === "activity") {
          expect(got.activityKind).toBe(want.activityKind);
          expect(got.localDate).toBe(
            want.localDate === "receipt-day" ? RECEIPT_DAY : null,
          );
          expect(got.datePrecision).toBe(
            want.localDate === null ? "unknown" : "day",
          );
          expect(got.beneficiaryReference).toBe(want.beneficiaryReference);
        } else if (
          want.kind === "contribution" &&
          got.kind === "contribution"
        ) {
          expect(got.durationMinutes).toBe(want.durationMinutes);
          expect(got.membershipId).toBe("member-demo");
        } else if (want.kind === "need" && got.kind === "need") {
          expect(got.category).toBe(want.category);
          expect(got.urgency).toBe(want.urgency);
          expect(got.provisional).toBe(want.provisional);
        } else if (want.kind === "correction" && got.kind === "correction") {
          expect(got.durationMinutes).toBe(want.durationMinutes);
          expect(got.targetId).toBe(want.targetId);
        }
      });
      expect(proposal.unresolved.map((entry) => entry.field).sort()).toEqual(
        [...expected.unresolvedFields].sort(),
      );
    });
  }
});
