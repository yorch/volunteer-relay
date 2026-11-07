import type { ExtractionProposal, SourceEnvelope } from "@relay/contracts";

/**
 * Evidence offsets are UTF-16 code-unit indices into the exact preserved source
 * revision, half-open [start, end). Quotes are never trusted from a model.
 */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export function findSpan(
  text: string,
  needle: string,
  from = 0,
): TextSpan | null {
  if (needle.length === 0) return null;
  const start = text.indexOf(needle, from);
  if (start < 0) return null;
  return { start, end: start + needle.length, quote: needle };
}

export function findPatternSpan(
  text: string,
  pattern: RegExp,
): TextSpan | null {
  const match = pattern.exec(text);
  const quote = match?.[0];
  if (match === null || quote === undefined || quote.length === 0) return null;
  return { start: match.index, end: match.index + quote.length, quote };
}

export interface EvidenceViolation {
  readonly itemIndex: number;
  readonly evidenceIndex: number;
  readonly reason: string;
}

/**
 * Rejects quoted spans that are not literally present in this revision, plus
 * cross-source, stale-revision and unknown-attachment references. Extraction
 * output is untrusted, so this runs before any proposal reaches review.
 *
 * Violations report array positions only. Provider-controlled identifiers
 * (item keys, field labels) are never echoed into errors or telemetry because
 * they can carry arbitrary source text.
 */
export function verifyProposalEvidence(
  proposal: ExtractionProposal,
  source: SourceEnvelope,
): EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];
  const attachmentIds = new Set(source.attachments.map((a) => a.id));
  for (const [itemIndex, item] of proposal.items.entries())
    for (const [evidenceIndex, entry] of item.evidence.entries()) {
      const violation = (reason: string): void => {
        violations.push({ itemIndex, evidenceIndex, reason });
      };
      if (entry.sourceId !== source.sourceId)
        violation("evidence_source_mismatch");
      if (entry.sourceRevision !== source.revision)
        violation("evidence_revision_mismatch");
      if (entry.kind === "text") {
        const slice = source.text.slice(entry.start, entry.end);
        if (
          entry.start < 0 ||
          entry.end > source.text.length ||
          entry.end <= entry.start ||
          slice !== entry.quote
        )
          violation("quote_not_in_source_revision");
      } else if (!attachmentIds.has(entry.attachmentId))
        violation("unknown_attachment");
    }
  return violations;
}
