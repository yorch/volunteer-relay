import { describe, expect, it } from "vitest";
import { sources } from "../../../fixtures/sources.ts";
import {
  extractionProposalSchema,
  sourceEnvelopeSchema,
  tenantContextSchema,
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
