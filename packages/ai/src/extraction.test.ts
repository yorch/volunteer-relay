import type {
  ExtractionProposal,
  Result,
  SourceEnvelope,
  TenantContext,
} from "@relay/contracts";
import {
  apiErrorSchema,
  extractionProposalSchema,
  sourceEnvelopeSchema,
} from "@relay/contracts";
import { describe, expect, it } from "vitest";
import { sources } from "../../../fixtures/sources.ts";
import {
  createDeterministicProvider,
  DETERMINISTIC_MODEL_VERSION,
  DETERMINISTIC_PROMPT_VERSION,
  requireSpan,
} from "./deterministic.ts";
import { findSpan, verifyProposalEvidence } from "./evidence.ts";
import type { ExtractionProvider, ProviderDraft } from "./provider.ts";
import { ExtractionProviderError } from "./provider.ts";
import { createExtractionService, type ExtractionAttempt } from "./service.ts";

const fixtureSources: readonly SourceEnvelope[] = sources.map((source) =>
  sourceEnvelopeSchema.parse(source),
);

const versions = {
  model: DETERMINISTIC_MODEL_VERSION,
  prompt: DETERMINISTIC_PROMPT_VERSION,
  policy: "review-all",
};

function contextFor(source: SourceEnvelope): TenantContext {
  return {
    organizationId: source.organizationId,
    actor: { kind: "system", service: "worker" },
    correlationId: `corr-${source.sourceId}`,
  };
}

function getSource(sourceId: string): SourceEnvelope {
  const source = fixtureSources.find(
    (candidate) => candidate.sourceId === sourceId,
  );
  if (source === undefined) throw new Error(`Missing fixture ${sourceId}`);
  return source;
}

function expectOk<T>(result: Result<T>): T {
  if (!result.ok)
    throw new Error(`Unexpected ${result.error.code}: ${result.error.message}`);
  return result.value;
}

function makeService(
  provider: ExtractionProvider,
  options: {
    maxAttempts?: number;
    onAttempt?: (record: ExtractionAttempt) => void;
  } = {},
) {
  let run = 0;
  return createExtractionService({
    provider,
    newRunId: () => {
      run += 1;
      return `run-test-${run}`;
    },
    ...options,
  });
}

const deterministic = createDeterministicProvider();

function deterministicDraftFor(source: SourceEnvelope): Promise<ProviderDraft> {
  return deterministic.extract({ source, versions }) as Promise<ProviderDraft>;
}

describe("ExtractionService contract boundary", () => {
  it("returns a contract-valid, evidence-faithful proposal for every fixture source", async () => {
    const service = makeService(deterministic);
    for (const source of fixtureSources) {
      const proposal = expectOk(
        await service.extract(contextFor(source), source, versions),
      );
      expect(extractionProposalSchema.safeParse(proposal).success).toBe(true);
      expect(verifyProposalEvidence(proposal, source)).toEqual([]);
      expect(proposal.organizationId).toBe(source.organizationId);
      expect(proposal.sourceId).toBe(source.sourceId);
      expect(proposal.sourceRevision).toBe(source.revision);
      expect(proposal.modelVersion).toBe(versions.model);
      expect(proposal.promptVersion).toBe(versions.prompt);
      expect(proposal.policyVersion).toBe(versions.policy);
      expect(proposal.runId.startsWith("run-test-")).toBe(true);
    }
  });

  it("refuses a source outside the resolved tenant context", async () => {
    const source = getSource("source-01");
    const service = makeService(deterministic);
    const result = await service.extract(
      { ...contextFor(source), organizationId: "harbor" },
      source,
      versions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FORBIDDEN");
    expect(result.error.retryable).toBe(false);
    expect(result.error.correlationId).toBe(contextFor(source).correlationId);
    expect(apiErrorSchema.safeParse({ error: result.error }).success).toBe(
      true,
    );
    // No source text may leak through an error envelope.
    expect(result.error.message).not.toContain("Mira");
  });

  it("preserves unknown duration as null instead of zero", async () => {
    const source = getSource("source-05");
    const proposal = expectOk(
      await makeService(deterministic).extract(
        contextFor(source),
        source,
        versions,
      ),
    );
    const contribution = proposal.items.find(
      (item) => item.kind === "contribution",
    );
    expect(contribution?.kind).toBe("contribution");
    if (contribution?.kind !== "contribution") return;
    expect(contribution.durationMinutes).toBeNull();
    expect(proposal.unresolved).toContainEqual({
      field: "durationMinutes",
      reason: "duration_not_reported",
    });
  });

  it("takes no business action from instruction-like source text", async () => {
    const source = getSource("source-08");
    const proposal = expectOk(
      await makeService(deterministic).extract(
        contextFor(source),
        source,
        versions,
      ),
    );
    expect(proposal.items).toEqual([]);
    expect(proposal.unresolved).toContainEqual({
      field: "text",
      reason: "instruction_like_content_ignored",
    });
  });

  it("does not infer identity, activity or hours from a photo alone", async () => {
    const source = getSource("source-26");
    const proposal = expectOk(
      await makeService(deterministic).extract(
        contextFor(source),
        source,
        versions,
      ),
    );
    expect(proposal.items).toEqual([]);
    expect(proposal.unresolved.map((entry) => entry.field)).toContain(
      "activity",
    );
  });

  it("extracts a synthetic source absent from the fixture set", async () => {
    const synthetic: SourceEnvelope = {
      schemaVersion: 1,
      organizationId: "zeta-org",
      sourceId: "synthetic-x",
      revision: 1,
      channel: "web",
      channelIdentity: "synthetic-zeta",
      externalMessageId: "9001",
      idempotencyKey: "zeta:9001",
      author: { externalIdentity: "Ada", membershipId: "zeta-ada" },
      occurredAt: "2026-11-04T15:00:00Z",
      receivedAt: "2026-11-04T15:01:00Z",
      timezone: "America/New_York",
      text: "Ada visited household Z-09 for 45 minutes on March 3.",
      attachments: [],
      replyToSourceId: null,
      replacesRevision: null,
      original: {
        mediaType: "text/plain",
        payload: "Ada visited household Z-09 for 45 minutes on March 3.",
      },
    };
    const proposal = expectOk(
      await makeService(deterministic).extract(
        contextFor(synthetic),
        synthetic,
        versions,
      ),
    );
    const activity = proposal.items.find((item) => item.kind === "activity");
    expect(activity?.kind).toBe("activity");
    if (activity?.kind !== "activity") return;
    expect(activity.activityKind).toBe("visit");
    expect(activity.beneficiaryReference).toBe("Z-09");
    expect(activity.localDate).toBe("2026-03-03");
    const contribution = proposal.items.find(
      (item) => item.kind === "contribution",
    );
    expect(contribution?.kind).toBe("contribution");
    if (contribution?.kind !== "contribution") return;
    expect(contribution.durationMinutes).toBe(45);
    expect(contribution.membershipId).toBe("zeta-ada");
  });
});

describe("bounded provider failure handling", () => {
  it("retries a transient failure within the attempt budget and records attempts", async () => {
    const source = getSource("source-01");
    const state = { calls: 0 };
    const attempts: ExtractionAttempt[] = [];
    const flaky: ExtractionProvider = {
      name: "flaky-stub",
      async extract(request) {
        state.calls += 1;
        if (state.calls <= 2)
          throw new ExtractionProviderError("provider timeout", {
            retryable: true,
          });
        return deterministic.extract(request);
      },
    };
    const proposal = expectOk(
      await makeService(flaky, {
        maxAttempts: 3,
        onAttempt: (record) => attempts.push(record),
      }).extract(contextFor(source), source, versions),
    );
    expect(state.calls).toBe(3);
    expect(attempts.map((record) => record.outcome)).toEqual([
      "provider_error",
      "provider_error",
      "ok",
    ]);
    expect(extractionProposalSchema.safeParse(proposal).success).toBe(true);
  });

  it("stops at the attempt budget and reports a retryable dependency failure", async () => {
    const source = getSource("source-01");
    const state = { calls: 0 };
    const broken: ExtractionProvider = {
      name: "broken-stub",
      async extract() {
        state.calls += 1;
        throw new ExtractionProviderError("upstream 503", {
          retryable: true,
        });
      },
    };
    const result = await makeService(broken, { maxAttempts: 2 }).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(state.calls).toBe(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).not.toContain("Mira");
    expect(apiErrorSchema.safeParse({ error: result.error }).success).toBe(
      true,
    );
  });

  it("does not retry a non-retryable provider rejection", async () => {
    const source = getSource("source-01");
    const state = { calls: 0 };
    const rejected: ExtractionProvider = {
      name: "rejected-stub",
      async extract() {
        state.calls += 1;
        throw new ExtractionProviderError("content policy rejection", {
          retryable: false,
        });
      },
    };
    const result = await makeService(rejected, { maxAttempts: 3 }).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(state.calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.retryable).toBe(false);
  });

  it("treats an unclassified provider exception as non-retryable", async () => {
    const source = getSource("source-01");
    const state = { calls: 0 };
    const hostile: ExtractionProvider = {
      name: "hostile-stub",
      async extract() {
        state.calls += 1;
        throw new Error("unclassified");
      },
    };
    const result = await makeService(hostile, { maxAttempts: 3 }).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(state.calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(result.error.retryable).toBe(false);
  });

  it("rejects a non-draft payload shape without retrying", async () => {
    const source = getSource("source-01");
    const state = { calls: 0 };
    const malformed: ExtractionProvider = {
      name: "malformed-stub",
      async extract() {
        state.calls += 1;
        return { analysis: "free text instead of a proposal" };
      },
    };
    const result = await makeService(malformed).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(state.calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.fields).toEqual({
      provider: ["invalid_draft_shape"],
    });
  });

  it("rejects schema-invalid model output", async () => {
    const source = getSource("source-01");
    const invalid: ExtractionProvider = {
      name: "invalid-schema-stub",
      async extract() {
        return {
          items: [
            {
              kind: "contribution",
              key: "bad-1",
              activityKey: "bad-activity",
              membershipId: "tidepath-mira",
              durationMinutes: 0,
              evidence: [
                {
                  kind: "text",
                  field: "durationMinutes",
                  sourceId: source.sourceId,
                  sourceRevision: source.revision,
                  start: 0,
                  end: 4,
                  quote: "Mira",
                },
              ],
            },
          ],
          unresolved: [],
        };
      },
    };
    const result = await makeService(invalid).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(Object.keys(result.error.fields ?? {})).toContain("items[0]");
  });

  it("rejects forged evidence quotes even when the schema is satisfied", async () => {
    const source = getSource("source-01");
    const draft = await deterministicDraftFor(source);
    const forged: ExtractionProvider = {
      name: "forged-evidence-stub",
      async extract() {
        const items = draft.items.map((item) => {
          const typed = item as ExtractionProposal["items"][number];
          return {
            ...typed,
            evidence: typed.evidence.map((entry) =>
              entry.kind === "text"
                ? { ...entry, quote: "fabricated quotation" }
                : entry,
            ),
          };
        });
        return { items, unresolved: draft.unresolved };
      },
    };
    const result = await makeService(forged).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    const fieldValues = Object.values(result.error.fields ?? {}).flat();
    expect(fieldValues).toContain("quote_not_in_source_revision");
    expect(result.error.message).not.toContain("Mira");
  });

  it("rejects cross-source and stale-revision evidence", async () => {
    const source = getSource("source-01");
    const span = requireSpan(source.text, "60 minutes");
    const wrongSource: ExtractionProvider = {
      name: "cross-source-stub",
      async extract() {
        return {
          items: [
            {
              kind: "need",
              key: "cross-1",
              category: "supplies",
              urgency: "routine",
              summary: "Synthetic",
              provisional: false,
              evidence: [
                {
                  kind: "text",
                  field: "summary",
                  sourceId: "source-99",
                  sourceRevision: source.revision,
                  ...span,
                },
              ],
            },
          ],
          unresolved: [],
        };
      },
    };
    const crossResult = await makeService(wrongSource).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(crossResult.ok).toBe(false);
    if (crossResult.ok) return;
    expect(Object.values(crossResult.error.fields ?? {}).flat()).toContain(
      "evidence_source_mismatch",
    );

    const staleRevision: ExtractionProvider = {
      name: "stale-revision-stub",
      async extract() {
        return {
          items: [
            {
              kind: "need",
              key: "stale-1",
              category: "supplies",
              urgency: "routine",
              summary: "Synthetic",
              provisional: false,
              evidence: [
                {
                  kind: "text",
                  field: "summary",
                  sourceId: source.sourceId,
                  sourceRevision: source.revision + 1,
                  ...span,
                },
              ],
            },
          ],
          unresolved: [],
        };
      },
    };
    const staleResult = await makeService(staleRevision).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(staleResult.ok).toBe(false);
    if (staleResult.ok) return;
    expect(Object.values(staleResult.error.fields ?? {}).flat()).toContain(
      "evidence_revision_mismatch",
    );
  });

  it("rejects an evidence attachment that is not on the source", async () => {
    const source = getSource("source-26");
    const fabricated: ExtractionProvider = {
      name: "fabricated-attachment-stub",
      async extract() {
        return {
          items: [
            {
              kind: "need",
              key: "attachment-1",
              category: "supplies",
              urgency: "routine",
              summary: "Synthetic",
              provisional: false,
              evidence: [
                {
                  kind: "attachment",
                  field: "summary",
                  sourceId: source.sourceId,
                  sourceRevision: source.revision,
                  attachmentId: "attachment-does-not-exist",
                  observation: "visible colour only",
                },
              ],
            },
          ],
          unresolved: [],
        };
      },
    };
    const result = await makeService(fabricated).extract(
      contextFor(source),
      source,
      versions,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.values(result.error.fields ?? {}).flat()).toContain(
      "unknown_attachment",
    );
  });

  it("rejects an impossible retry budget", () => {
    expect(() => makeService(deterministic, { maxAttempts: 0 })).toThrow(
      RangeError,
    );
  });
});

describe("evidence span helpers", () => {
  it("locates exact UTF-16 spans and returns null for absent text", () => {
    const text = "Mira visited T-01 for 60 minutes.";
    expect(findSpan(text, "60 minutes")).toEqual({
      start: 22,
      end: 32,
      quote: "60 minutes",
    });
    expect(text.slice(22, 32)).toBe("60 minutes");
    expect(findSpan(text, "90 minutes")).toBeNull();
    expect(findSpan(text, "")).toBeNull();
  });
});

describe("error envelopes never echo provider-controlled identifiers", () => {
  function forgedIdentifierProvider(
    source: SourceEnvelope,
    options: { extraProviderKey: boolean },
  ): ExtractionProvider {
    const hostileLabel = source.text;
    return {
      name: "hostile-identifier-stub",
      async extract() {
        const item = {
          kind: "need",
          key: hostileLabel,
          category: "supplies",
          urgency: "routine",
          summary: "Synthetic",
          provisional: false,
          evidence: [
            {
              kind: "text",
              field: hostileLabel,
              sourceId: source.sourceId,
              sourceRevision: source.revision,
              start: 0,
              end: 5,
              quote: "forged",
            },
          ],
        };
        return {
          items: [
            options.extraProviderKey
              ? { ...item, [hostileLabel]: "extra" }
              : item,
          ],
          unresolved: [],
        };
      },
    };
  }

  it("reports a safe index path when the item key and evidence field carry source text", async () => {
    const source = getSource("source-01");
    const text = source.text;
    const attempts: ExtractionAttempt[] = [];
    const result = await makeService(
      forgedIdentifierProvider(source, { extraProviderKey: false }),
      { onAttempt: (record) => attempts.push(record) },
    ).extract(contextFor(source), source, versions);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(apiErrorSchema.safeParse({ error: result.error }).success).toBe(
      true,
    );
    expect(Object.keys(result.error.fields ?? {})).toEqual([
      "items[0].evidence[0]",
    ]);
    expect(result.error.fields?.["items[0].evidence[0]"]).toEqual([
      "quote_not_in_source_revision",
    ]);
    expect(result.error.fields).not.toHaveProperty(text);
    expect(JSON.stringify(result)).not.toContain(text);
    expect(JSON.stringify(attempts)).not.toContain(text);
    expect(attempts.map((record) => record.outcome)).toEqual([
      "evidence_invalid",
    ]);
  });

  it("does not echo an unrecognized provider key that carries source text", async () => {
    const source = getSource("source-01");
    const text = source.text;
    const attempts: ExtractionAttempt[] = [];
    const result = await makeService(
      forgedIdentifierProvider(source, { extraProviderKey: true }),
      { onAttempt: (record) => attempts.push(record) },
    ).extract(contextFor(source), source, versions);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(apiErrorSchema.safeParse({ error: result.error }).success).toBe(
      true,
    );
    expect(result.error.fields).toEqual({
      "items[0]": ["root:unrecognized_keys"],
    });
    expect(JSON.stringify(result)).not.toContain(text);
    expect(JSON.stringify(attempts)).not.toContain(text);
    expect(attempts.map((record) => record.outcome)).toEqual([
      "schema_invalid",
    ]);
  });
});
