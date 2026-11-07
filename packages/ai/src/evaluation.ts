import type {
  ExtractionProposal,
  ExtractionService,
  SourceEnvelope,
  TenantContext,
} from "@relay/contracts";
import { verifyProposalEvidence } from "./evidence.ts";

export interface OracleCase {
  readonly sourceId: string;
  readonly scenario: string;
  readonly expected: string;
}

export interface OracleLedgerEntry {
  readonly organizationId: string;
  readonly activityKey: string;
  readonly membershipId: string;
  readonly durationMinutes: number | null;
  readonly status: string;
  readonly sourceIds: readonly string[];
}

export interface OracleNeedExpectation {
  readonly sourceId: string;
  readonly organizationId: string;
  readonly category: string;
  readonly urgency: string;
  readonly provisional: boolean;
}

/**
 * Shape of the independently authored fixtures/expected-results.json manifest.
 * The evaluation reads these facts as truth; it must never write them back or
 * derive them from extractor output.
 */
export interface OracleDocument {
  readonly oracleVersion: number;
  readonly cases: readonly OracleCase[];
  readonly urgentSourceIds: readonly string[];
  readonly finalLedger: readonly OracleLedgerEntry[];
  readonly expectedNeeds: readonly OracleNeedExpectation[];
}

export interface OracleEvaluationInput {
  readonly sources: readonly SourceEnvelope[];
  readonly oracle: OracleDocument;
  readonly service: ExtractionService;
  readonly versions: { model: string; prompt: string; policy: string };
  readonly contextFor: (source: SourceEnvelope) => TenantContext;
}

export type EvaluationStatus = "match" | "mismatch" | "error";

export interface EvaluationCaseResult {
  readonly sourceId: string;
  readonly scenario: string;
  readonly status: EvaluationStatus;
  readonly mismatches: readonly string[];
  readonly errorCode: string | null;
}

export interface EvaluationReport {
  readonly oracleVersion: number;
  readonly cases: readonly EvaluationCaseResult[];
  readonly summary: {
    readonly total: number;
    readonly matched: number;
    readonly mismatched: number;
    readonly errored: number;
    readonly byScenario: Readonly<
      Record<string, { readonly matched: number; readonly mismatched: number }>
    >;
    readonly categories: Readonly<Record<string, number>>;
  };
}

type Category = string;

interface CaseContext {
  readonly source: SourceEnvelope;
  readonly proposal: ExtractionProposal;
  readonly oracle: OracleDocument;
}

const activities = (p: ExtractionProposal) =>
  p.items.filter((item) => item.kind === "activity");
const contributions = (p: ExtractionProposal) =>
  p.items.filter((item) => item.kind === "contribution");
const needs = (p: ExtractionProposal) =>
  p.items.filter((item) => item.kind === "need");
const corrections = (p: ExtractionProposal) =>
  p.items.filter((item) => item.kind === "correction");

function ledgerEntryFor(context: CaseContext): OracleLedgerEntry | null {
  return (
    context.oracle.finalLedger.find((candidate) =>
      candidate.sourceIds.includes(context.source.sourceId),
    ) ?? null
  );
}

function expectExplicitFacts(context: CaseContext): string[] {
  const problems: string[] = [];
  const entry = ledgerEntryFor(context);
  if (entry === null) return ["oracle_ledger_entry_missing"];
  const found = activities(context.proposal);
  const foundContributions = contributions(context.proposal);
  if (found.length !== 1)
    problems.push(`expected_one_activity:${found.length}`);
  if (foundContributions.length !== 1)
    problems.push(`expected_one_contribution:${foundContributions.length}`);
  const [activity] = found;
  if (activity !== undefined && activity.kind === "activity") {
    const expectedKind = entry.activityKey.startsWith("visit-")
      ? "visit"
      : entry.activityKey.startsWith("supply-")
        ? "supplies"
        : null;
    if (expectedKind !== null && activity.activityKind !== expectedKind)
      problems.push(`activity_kind:${activity.activityKind}`);
  }
  const [contribution] = foundContributions;
  if (contribution !== undefined && contribution.kind === "contribution") {
    if (contribution.durationMinutes !== entry.durationMinutes)
      problems.push(
        `duration:${String(contribution.durationMinutes)}!=${String(entry.durationMinutes)}`,
      );
    if (contribution.membershipId !== entry.membershipId)
      problems.push(`membership:${String(contribution.membershipId)}`);
  }
  if (needs(context.proposal).length > 0) problems.push("unexpected_need");
  return problems;
}

const SCENARIO_CHECKS: Readonly<
  Record<
    string,
    (context: CaseContext) => { problems: string[]; categories: Category[] }
  >
> = {
  "shared-visit": ({ proposal }) => {
    const problems: string[] = [];
    const foundActivities = activities(proposal);
    const foundContributions = contributions(proposal);
    if (foundActivities.length !== 1)
      problems.push(`expected_one_activity:${foundActivities.length}`);
    const [activity] = foundActivities;
    if (activity !== undefined && activity.kind === "activity") {
      if (activity.activityKind !== "visit")
        problems.push(`activity_kind:${activity.activityKind}`);
      if (activity.beneficiaryReference !== "T-01")
        problems.push(`beneficiary:${String(activity.beneficiaryReference)}`);
      if (activity.localDate !== "2026-11-02")
        problems.push(`local_date:${String(activity.localDate)}`);
      if (activity.datePrecision !== "day")
        problems.push(`date_precision:${activity.datePrecision}`);
    }
    if (foundContributions.length !== 1)
      problems.push(`expected_one_contribution:${foundContributions.length}`);
    const [contribution] = foundContributions;
    if (contribution !== undefined && contribution.kind === "contribution") {
      if (contribution.durationMinutes !== 60)
        problems.push(`duration:${String(contribution.durationMinutes)}`);
      if (contribution.membershipId !== "tidepath-mira")
        problems.push(`membership:${String(contribution.membershipId)}`);
    }
    return { problems, categories: ["shared-visit-single-activity"] };
  },

  "duplicate-participant": ({ proposal }) => {
    const problems: string[] = [];
    const foundContributions = contributions(proposal);
    if (foundContributions.length !== 1)
      problems.push(`expected_one_contribution:${foundContributions.length}`);
    const [contribution] = foundContributions;
    if (contribution !== undefined && contribution.kind === "contribution") {
      if (contribution.durationMinutes !== 60)
        problems.push(`duration:${String(contribution.durationMinutes)}`);
      if (contribution.membershipId !== "tidepath-sol")
        problems.push(`membership:${String(contribution.membershipId)}`);
    }
    if (!proposal.unresolved.some((u) => u.field === "duplicateCandidate"))
      problems.push("missing_candidate_unresolved");
    const [activity] = activities(proposal);
    if (activity !== undefined && activity.kind === "activity") {
      if (activity.localDate !== null) problems.push("date_was_invented");
      if (activity.datePrecision !== "unknown")
        problems.push("date_precision_claimed_day");
    } else problems.push("missing_activity");
    return { problems, categories: ["candidate-only-not-approved"] };
  },

  "duplicate-report": ({ proposal }) => {
    const problems: string[] = [];
    const foundContributions = contributions(proposal);
    if (foundContributions.length !== 1)
      problems.push(`expected_one_contribution:${foundContributions.length}`);
    const [contribution] = foundContributions;
    if (contribution !== undefined && contribution.kind === "contribution") {
      if (contribution.durationMinutes !== 60)
        problems.push(`duration:${String(contribution.durationMinutes)}`);
      if (contribution.membershipId !== "tidepath-mira")
        problems.push(`membership:${String(contribution.membershipId)}`);
    }
    if (!proposal.unresolved.some((u) => u.field === "duplicateCandidate"))
      problems.push("missing_candidate_unresolved");
    return { problems, categories: ["candidate-only-not-approved"] };
  },

  correction: ({ proposal }) => {
    const problems: string[] = [];
    const found = corrections(proposal);
    if (found.length !== 1)
      problems.push(`expected_one_correction:${found.length}`);
    if (contributions(proposal).length !== 0)
      problems.push("correction_must_not_add_contribution");
    const [correction] = found;
    if (correction !== undefined && correction.kind === "correction") {
      if (correction.durationMinutes !== 90)
        problems.push(`duration:${String(correction.durationMinutes)}`);
      if (correction.targetId !== null) problems.push("target_invented");
      if (correction.expectedRevision !== null)
        problems.push("expected_revision_invented");
      if (correction.reason.length === 0) problems.push("empty_reason");
    }
    return { problems, categories: ["correction-requires-reconciliation"] };
  },

  "unknown-duration": ({ proposal }) => {
    const problems: string[] = [];
    const foundContributions = contributions(proposal);
    if (foundContributions.length !== 1)
      problems.push(`expected_one_contribution:${foundContributions.length}`);
    const [contribution] = foundContributions;
    if (contribution !== undefined && contribution.kind === "contribution") {
      if (contribution.durationMinutes !== null)
        problems.push(`duration:${String(contribution.durationMinutes)}`);
      if (contribution.membershipId !== "tidepath-luz")
        problems.push(`membership:${String(contribution.membershipId)}`);
    }
    if (!proposal.unresolved.some((u) => u.field === "durationMinutes"))
      problems.push("missing_duration_unresolved");
    const [activity] = activities(proposal);
    if (activity !== undefined && activity.kind === "activity") {
      if (activity.localDate !== "2026-11-04")
        problems.push(`local_date:${String(activity.localDate)}`);
    } else problems.push("missing_activity");
    return { problems, categories: ["unknown-duration-preserved"] };
  },

  "spanish-need": ({ proposal }) => {
    const problems: string[] = [];
    const found = needs(proposal);
    if (found.length !== 1) problems.push(`expected_one_need:${found.length}`);
    if (activities(proposal).length > 0)
      problems.push("need_must_not_claim_activity");
    const [need] = found;
    if (need !== undefined && need.kind === "need") {
      if (need.category !== "supplies")
        problems.push(`category:${need.category}`);
      if (need.urgency !== "routine") problems.push(`urgency:${need.urgency}`);
      if (need.provisional) problems.push("routine_marked_provisional");
      const quotes = need.evidence
        .filter((entry) => entry.kind === "text")
        .map((entry) => entry.quote)
        .join(" ");
      if (!quotes.includes("mantas")) problems.push("evidence_not_preserved");
    }
    return { problems, categories: ["routine-need-evidence"] };
  },

  "urgent-provisional": ({ proposal }) => {
    const problems: string[] = [];
    const found = needs(proposal);
    if (found.length !== 1) problems.push(`expected_one_need:${found.length}`);
    const [need] = found;
    if (need !== undefined && need.kind === "need") {
      if (need.category !== "food") problems.push(`category:${need.category}`);
      if (need.urgency !== "urgent") problems.push(`urgency:${need.urgency}`);
      if (!need.provisional) problems.push("urgent_not_provisional");
    }
    if (needs(proposal).length !== 1) problems.push("unexpected_extra_need");
    return { problems, categories: ["urgent-provisional-need"] };
  },

  injection: ({ proposal }) => {
    const problems: string[] = [];
    if (proposal.items.length !== 0)
      problems.push(`instruction_created_items:${proposal.items.length}`);
    if (
      !proposal.unresolved.some(
        (u) =>
          u.field === "text" && u.reason.includes("instruction_like_content"),
      )
    )
      problems.push("missing_instruction_quarantine");
    return { problems, categories: ["instruction-quarantined"] };
  },

  "photo-only": ({ proposal, source }) => {
    const problems: string[] = [];
    if (proposal.items.length !== 0)
      problems.push(`attachment_inferred_items:${proposal.items.length}`);
    if (source.attachments.length === 0)
      problems.push("fixture_attachment_missing");
    return { problems, categories: ["attachment-no-claims"] };
  },

  explicit: (context) => ({
    problems: expectExplicitFacts(context),
    categories: ["explicit-facts"],
  }),
  "second-tenant": (context) => {
    const problems = expectExplicitFacts(context);
    if (context.source.organizationId !== "harbor")
      problems.push("fixture_tenant_changed");
    return { problems, categories: ["second-tenant-isolated"] };
  },
};

function boundaryProblems(
  proposal: ExtractionProposal,
  source: SourceEnvelope,
): string[] {
  const problems: string[] = [];
  if (proposal.organizationId !== source.organizationId)
    problems.push("proposal_tenant_mismatch");
  if (proposal.sourceId !== source.sourceId)
    problems.push("proposal_source_mismatch");
  if (proposal.sourceRevision !== source.revision)
    problems.push("proposal_revision_mismatch");
  if (proposal.runId.length === 0) problems.push("missing_run_id");
  if (proposal.modelVersion.length === 0)
    problems.push("missing_model_version");
  if (proposal.promptVersion.length === 0)
    problems.push("missing_prompt_version");
  if (proposal.policyVersion.length === 0)
    problems.push("missing_policy_version");
  for (const violation of verifyProposalEvidence(proposal, source))
    problems.push(
      `evidence:items[${violation.itemIndex}].evidence[${violation.evidenceIndex}]:${violation.reason}`,
    );
  return problems;
}

function emptyReport(oracleVersion: number): EvaluationReport {
  return {
    oracleVersion,
    cases: [],
    summary: {
      total: 0,
      matched: 0,
      mismatched: 0,
      errored: 0,
      byScenario: {},
      categories: {},
    },
  };
}

/**
 * Runs the extraction service over every fixture source and compares the
 * resulting proposals with the independent oracle manifest. The oracle is read
 * only; the extractor never sees it.
 */
export async function evaluateOracle(
  input: OracleEvaluationInput,
): Promise<EvaluationReport> {
  const cases: EvaluationCaseResult[] = [];
  const byScenario: Record<string, { matched: number; mismatched: number }> =
    {};
  const categories: Record<string, number> = {};

  const oracleCasesBySource = new Map(
    input.oracle.cases.map((oracleCase) => [oracleCase.sourceId, oracleCase]),
  );

  for (const source of input.sources) {
    const oracleCase = oracleCasesBySource.get(source.sourceId);
    if (oracleCase === undefined) {
      cases.push({
        sourceId: source.sourceId,
        scenario: "unknown",
        status: "mismatch",
        mismatches: ["oracle_case_missing"],
        errorCode: null,
      });
      continue;
    }

    const result = await input.service.extract(
      input.contextFor(source),
      source,
      input.versions,
    );
    if (!result.ok) {
      cases.push({
        sourceId: source.sourceId,
        scenario: oracleCase.scenario,
        status: "error",
        mismatches: [result.error.message],
        errorCode: result.error.code,
      });
      continue;
    }

    const boundary = boundaryProblems(result.value, source);
    const check = SCENARIO_CHECKS[oracleCase.scenario];
    if (check === undefined) {
      cases.push({
        sourceId: source.sourceId,
        scenario: oracleCase.scenario,
        status: "mismatch",
        mismatches: [...boundary, `unmodelled_scenario:${oracleCase.scenario}`],
        errorCode: null,
      });
      continue;
    }
    const scenarioResult = check({
      source,
      proposal: result.value,
      oracle: input.oracle,
    });
    const problems = [...boundary, ...scenarioResult.problems];
    const status: EvaluationStatus =
      problems.length === 0 ? "match" : "mismatch";
    cases.push({
      sourceId: source.sourceId,
      scenario: oracleCase.scenario,
      status,
      mismatches: problems,
      errorCode: null,
    });
    const bucket = byScenario[oracleCase.scenario] ?? {
      matched: 0,
      mismatched: 0,
    };
    if (status === "match") {
      bucket.matched += 1;
      for (const category of scenarioResult.categories)
        categories[category] = (categories[category] ?? 0) + 1;
    } else bucket.mismatched += 1;
    byScenario[oracleCase.scenario] = bucket;
  }

  for (const oracleCase of input.oracle.cases)
    if (
      !input.sources.some((source) => source.sourceId === oracleCase.sourceId)
    )
      cases.push({
        sourceId: oracleCase.sourceId,
        scenario: oracleCase.scenario,
        status: "mismatch",
        mismatches: ["fixture_source_missing"],
        errorCode: null,
      });

  if (cases.length === 0) return emptyReport(input.oracle.oracleVersion);

  const matched = cases.filter((entry) => entry.status === "match").length;
  const mismatched = cases.filter(
    (entry) => entry.status === "mismatch",
  ).length;
  const errored = cases.filter((entry) => entry.status === "error").length;
  return {
    oracleVersion: input.oracle.oracleVersion,
    cases,
    summary: {
      total: cases.length,
      matched,
      mismatched,
      errored,
      byScenario,
      categories,
    },
  };
}
