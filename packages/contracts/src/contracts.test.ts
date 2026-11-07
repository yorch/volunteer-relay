import { describe, expect, it } from "vitest";
import { sources } from "../../../fixtures/sources.ts";
import {
  extractionProposalSchema,
  reviewDecisionSchema,
  reviewOutcomeSchema,
  reviewQueueEntrySchema,
  sourceEnvelopeSchema,
  tenantContextSchema,
  webSourceSubmissionSchema,
} from "./index.ts";

describe("frozen boundary validation", () => {
  it("accepts all synthetic sources", () => {
    for (const source of sources)
      expect(sourceEnvelopeSchema.safeParse(source).success).toBe(true);
  });
  it("rejects cross-tenant attachments", () => {
    expect(
      sourceEnvelopeSchema.safeParse({
        ...sources[0],
        attachments: [
          {
            id: "a",
            organizationId: "other",
            storageKey: "private/a",
            sha256: "a".repeat(64),
            mimeType: "image/png",
            bytes: 1,
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects unrecognized authority", () => {
    expect(
      tenantContextSchema.safeParse({
        organizationId: "a",
        actor: {
          kind: "user",
          userId: "u",
          membershipId: "m",
          role: "superadmin",
        },
        correlationId: "c",
      }).success,
    ).toBe(false);
  });
  it("keeps unknown duration nullable and rejects fractional minutes", () => {
    const proposal = {
      schemaVersion: 1,
      organizationId: "a",
      sourceId: "s",
      sourceRevision: 1,
      runId: "r",
      modelVersion: "stub",
      promptVersion: "1",
      policyVersion: "1",
      unresolved: [],
      items: [
        {
          kind: "contribution",
          key: "c",
          activityKey: "a",
          membershipId: null,
          durationMinutes: null,
          evidence: [
            {
              kind: "text",
              field: "durationMinutes",
              sourceId: "s",
              sourceRevision: 1,
              start: 0,
              end: 5,
              quote: "visit",
            },
          ],
        },
      ],
    };
    expect(extractionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(
      extractionProposalSchema.safeParse({
        ...proposal,
        items: [{ ...proposal.items[0], durationMinutes: 1.5 }],
      }).success,
    ).toBe(false);
  });
});

describe("second-wave additive UI contracts", () => {
  it("keeps tenant and source authority out of the text submission body", () => {
    const valid = {
      schemaVersion: 1,
      idempotencyKey: "synthetic-key",
      text: "  A synthetic update  ",
    };
    expect(webSourceSubmissionSchema.parse(valid)).toEqual(valid);
    for (const extra of [
      { organizationId: "other" },
      { membershipId: "other" },
      { attachments: [] },
    ]) {
      expect(
        webSourceSubmissionSchema.safeParse({ ...valid, ...extra }).success,
      ).toBe(false);
    }
    expect(
      webSourceSubmissionSchema.safeParse({ ...valid, text: " \n\t" }).success,
    ).toBe(false);
    expect(
      webSourceSubmissionSchema.safeParse({ ...valid, text: "a".repeat(20000) })
        .success,
    ).toBe(true);
    expect(
      webSourceSubmissionSchema.safeParse({
        ...valid,
        text: "😀".repeat(10001),
      }).success,
    ).toBe(false);
  });

  it("preserves the existing accept/reject decision and positive optimistic revision", () => {
    const command = {
      runId: "synthetic-run",
      expectedRevision: 4,
      idempotencyKey: "synthetic-review",
      decision: "accept",
      reason: "",
    };
    expect(reviewDecisionSchema.parse(command)).toEqual(command);
    expect(
      reviewDecisionSchema.safeParse({ ...command, decision: "edit" }).success,
    ).toBe(false);
    expect(
      reviewDecisionSchema.safeParse({ ...command, expectedRevision: 0 })
        .success,
    ).toBe(false);
    expect(
      reviewDecisionSchema.safeParse({ ...command, edits: {} }).success,
    ).toBe(false);
    expect(reviewOutcomeSchema.parse({ revision: 5 })).toEqual({ revision: 5 });
    expect(reviewOutcomeSchema.safeParse({ revision: 1.5 }).success).toBe(
      false,
    );
  });

  it("pairs only the same tenant/source revision while retaining an independent review revision", () => {
    const source = sources[0];
    if (!source) throw new Error("Synthetic source fixture missing");
    const proposal = {
      schemaVersion: 1,
      organizationId: source.organizationId,
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      runId: "synthetic-run",
      modelVersion: "synthetic",
      promptVersion: "1",
      policyVersion: "1",
      items: [],
      unresolved: [],
    };
    const entry = { schemaVersion: 1, source, proposal, revision: 4 };
    expect(reviewQueueEntrySchema.parse(entry).revision).toBe(4);
    for (const patch of [
      { organizationId: "other-org" },
      { sourceId: "other-source" },
      { sourceRevision: source.revision + 1 },
    ]) {
      expect(
        reviewQueueEntrySchema.safeParse({
          ...entry,
          proposal: { ...proposal, ...patch },
        }).success,
      ).toBe(false);
    }
    expect(
      reviewQueueEntrySchema.safeParse({ ...entry, revision: 0 }).success,
    ).toBe(false);
  });
});
