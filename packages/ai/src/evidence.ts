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
  readonly itemKey: string;
  readonly field: string;
  readonly reason: string;
}

/**
 * Rejects quoted spans that are not literally present in this revision, plus
 * cross-source, stale-revision and unknown-attachment references. Extraction
 * output is untrusted, so this runs before any proposal reaches review.
 */
export function verifyProposalEvidence(
  proposal: ExtractionProposal,
  source: SourceEnvelope,
): EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];
  const attachmentIds = new Set(source.attachments.map((a) => a.id));
  for (const item of proposal.items)
    for (const entry of item.evidence) {
      if (entry.sourceId !== source.sourceId)
        violations.push({
          itemKey: item.key,
          field: entry.field,
          reason: "evidence_source_mismatch",
        });
      if (entry.sourceRevision !== source.revision)
        violations.push({
          itemKey: item.key,
          field: entry.field,
          reason: "evidence_revision_mismatch",
        });
      if (entry.kind === "text") {
        const slice = source.text.slice(entry.start, entry.end);
        if (
          entry.start < 0 ||
          entry.end > source.text.length ||
          entry.end <= entry.start ||
          slice !== entry.quote
        )
          violations.push({
            itemKey: item.key,
            field: entry.field,
            reason: "quote_not_in_source_revision",
          });
      } else if (!attachmentIds.has(entry.attachmentId))
        violations.push({
          itemKey: item.key,
          field: entry.field,
          reason: "unknown_attachment",
        });
    }
  return violations;
}
