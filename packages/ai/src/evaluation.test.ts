import type { SourceEnvelope, TenantContext } from "@relay/contracts";
import { sourceEnvelopeSchema } from "@relay/contracts";
import { describe, expect, it } from "vitest";
import oracleJson from "../../../fixtures/expected-results.json" with {
  type: "json",
};
import { sources } from "../../../fixtures/sources.ts";
import {
  createDeterministicProvider,
  DETERMINISTIC_MODEL_VERSION,
  DETERMINISTIC_PROMPT_VERSION,
} from "./deterministic.ts";
import { evaluateOracle, type OracleDocument } from "./evaluation.ts";
import type { ExtractionProvider, ProviderDraft } from "./provider.ts";
import { createExtractionService } from "./service.ts";

const fixtureSources: readonly SourceEnvelope[] = sources.map((source) =>
  sourceEnvelopeSchema.parse(source),
);
const oracle = oracleJson as OracleDocument;

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

function serviceFor(provider: ExtractionProvider) {
  let run = 0;
  return createExtractionService({
    provider,
    newRunId: () => {
      run += 1;
      return `eval-run-${run}`;
    },
  });
}

function overrideProvider(
  mutate: (source: SourceEnvelope, draft: ProviderDraft) => unknown,
): ExtractionProvider {
  const inner = createDeterministicProvider();
  return {
    name: "override-stub",
    async extract(request) {
      const draft = (await inner.extract(request)) as ProviderDraft;
      return mutate(request.source, draft);
    },
  };
}

describe("oracle comparison over the synthetic benchmark", () => {
  it("matches every independently authored case with the provider-free adapter", async () => {
    const report = await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(createDeterministicProvider()),
      versions,
      contextFor,
    });

    const failures = report.cases.filter((entry) => entry.status !== "match");
    expect(failures).toEqual([]);
    expect(report.summary.total).toBe(oracle.cases.length);
    expect(report.summary.total).toBe(28);
    expect(report.summary.matched).toBe(28);
    expect(report.summary.mismatched).toBe(0);
    expect(report.summary.errored).toBe(0);
    expect(report.oracleVersion).toBe(oracle.oracleVersion);
    expect(report.summary.byScenario.explicit).toEqual({
      matched: 16,
      mismatched: 0,
    });
    expect(report.summary.byScenario["photo-only"]).toEqual({
      matched: 3,
      mismatched: 0,
    });
    for (const category of [
      "shared-visit-single-activity",
      "candidate-only-not-approved",
      "correction-requires-reconciliation",
      "unknown-duration-preserved",
      "routine-need-evidence",
      "urgent-provisional-need",
      "instruction-quarantined",
      "attachment-no-claims",
      "explicit-facts",
      "second-tenant-isolated",
    ])
      expect(report.summary.categories[category]).toBeGreaterThan(0);
  });

  it("passes every source exactly once through the extractor", async () => {
    const seen: string[] = [];
    const inner = createDeterministicProvider();
    const instrumented: ExtractionProvider = {
      name: "instrumented-stub",
      async extract(request) {
        seen.push(request.source.sourceId);
        return inner.extract(request);
      },
    };
    await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(instrumented),
      versions,
      contextFor,
    });
    expect(seen).toEqual(fixtureSources.map((source) => source.sourceId));
  });

  it("never mutates the independently authored oracle", async () => {
    const before = JSON.stringify(oracle);
    await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(createDeterministicProvider()),
      versions,
      contextFor,
    });
    expect(JSON.stringify(oracle)).toBe(before);
  });

  it("fails the case when the extractor drops an unknown-duration contribution", async () => {
    const report = await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(
        overrideProvider((source, draft) =>
          source.sourceId === "source-05"
            ? { items: [], unresolved: draft.unresolved }
            : draft,
        ),
      ),
      versions,
      contextFor,
    });
    const failed = report.cases.filter((entry) => entry.status !== "match");
    expect(failed.map((entry) => entry.sourceId)).toEqual(["source-05"]);
    expect(report.summary.matched).toBe(27);
    expect(report.summary.mismatched).toBe(1);
  });

  it("fails the case when the extractor invents a duration for an untracked visit", async () => {
    const report = await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(
        overrideProvider((source, draft) => {
          if (source.sourceId !== "source-05") return draft;
          return {
            items: draft.items.map((item) => {
              const entry = item as {
                kind: string;
                durationMinutes?: number | null;
              };
              return entry.kind === "contribution"
                ? { ...entry, durationMinutes: 15 }
                : entry;
            }),
            unresolved: draft.unresolved,
          };
        }),
      ),
      versions,
      contextFor,
    });
    const failed = report.cases.find((entry) => entry.status !== "match");
    expect(failed?.sourceId).toBe("source-05");
    expect(failed?.mismatches).toContain("duration:15");
  });

  it("flags an oracle scenario the harness does not model", async () => {
    const mutated: OracleDocument = {
      ...oracle,
      cases: oracle.cases.map((entry) =>
        entry.sourceId === "source-10"
          ? { ...entry, scenario: "unmodelled-scenario" }
          : entry,
      ),
    };
    const report = await evaluateOracle({
      sources: fixtureSources,
      oracle: mutated,
      service: serviceFor(createDeterministicProvider()),
      versions,
      contextFor,
    });
    const failed = report.cases.find((entry) => entry.status !== "match");
    expect(failed?.sourceId).toBe("source-10");
    expect(failed?.mismatches).toContain(
      "unmodelled_scenario:unmodelled-scenario",
    );
  });

  it("reports a provider failure instead of inventing a match", async () => {
    const inner = createDeterministicProvider();
    const failing: ExtractionProvider = {
      name: "failing-stub",
      async extract(request) {
        if (request.source.sourceId === "source-07") throw new Error("boom");
        return inner.extract(request);
      },
    };
    const report = await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(failing),
      versions,
      contextFor,
    });
    const errored = report.cases.filter((entry) => entry.status === "error");
    expect(errored.map((entry) => entry.sourceId)).toEqual(["source-07"]);
    expect(errored[0]?.errorCode).toBe("DEPENDENCY_UNAVAILABLE");
    expect(report.summary.errored).toBe(1);
    expect(report.summary.matched).toBe(27);
  });

  it("rejects a cross-tenant context instead of proposing facts", async () => {
    const report = await evaluateOracle({
      sources: fixtureSources,
      oracle,
      service: serviceFor(createDeterministicProvider()),
      versions,
      contextFor: (source) => ({
        ...contextFor(source),
        organizationId: "someone-else",
      }),
    });
    expect(report.summary.errored).toBe(28);
    expect(report.summary.matched).toBe(0);
    expect(
      report.cases.every(
        (entry) => entry.status === "error" && entry.errorCode === "FORBIDDEN",
      ),
    ).toBe(true);
  });
});
