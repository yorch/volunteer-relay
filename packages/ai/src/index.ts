// Extraction and evaluation boundary for lane D. See docs/tasks/P2-01.md.

export {
  createDeterministicProvider,
  DETERMINISTIC_MODEL_VERSION,
  DETERMINISTIC_PROMPT_VERSION,
  requireSpan,
} from "./deterministic.ts";
export type {
  EvaluationCaseResult,
  EvaluationReport,
  EvaluationStatus,
  OracleCase,
  OracleDocument,
  OracleEvaluationInput,
  OracleLedgerEntry,
  OracleNeedExpectation,
} from "./evaluation.ts";
export { evaluateOracle } from "./evaluation.ts";
export type { EvidenceViolation, TextSpan } from "./evidence.ts";
export {
  findPatternSpan,
  findSpan,
  verifyProposalEvidence,
} from "./evidence.ts";
export type {
  ExtractionProvider,
  ExtractionProviderRequest,
  ExtractionVersions,
  ProviderDraft,
} from "./provider.ts";
export {
  ExtractionProviderError,
  isProviderDraft,
} from "./provider.ts";
export type {
  ExtractionAttempt,
  ExtractionServiceOptions,
} from "./service.ts";
export { createExtractionService } from "./service.ts";
