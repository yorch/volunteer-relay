import { and, eq } from "drizzle-orm";
import { sourceAttachmentIdentity, sourceRevision } from "../schema/index.ts";
import type { Database } from "../types.ts";

// Structural mirror of the AttachmentMetadataStore port declared in
// packages/domain/core; blob bytes live behind a separate injected reader.

export interface StoredAttachmentMetadataRecord {
  storageKey: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  authorMembershipId: string | null;
}

export interface AttachmentMetadataStoreRecord {
  find(
    organizationId: string,
    sourceId: string,
    attachmentId: string,
  ): Promise<StoredAttachmentMetadataRecord | null>;
}

// Attachment identity is immutable per tenant + source; the authoring
// membership comes from the source's first revision (author identity is stable
// across revisions, enforced by the source store).
export function createAttachmentMetadataStore(
  db: Database,
): AttachmentMetadataStoreRecord {
  return {
    async find(organizationId, sourceId, attachmentId) {
      const rows = await db
        .select({
          storageKey: sourceAttachmentIdentity.storageKey,
          sha256: sourceAttachmentIdentity.sha256,
          mimeType: sourceAttachmentIdentity.mimeType,
          bytes: sourceAttachmentIdentity.bytes,
          authorMembershipId: sourceRevision.authorMembershipId,
        })
        .from(sourceAttachmentIdentity)
        .innerJoin(
          sourceRevision,
          and(
            eq(
              sourceRevision.organizationId,
              sourceAttachmentIdentity.organizationId,
            ),
            eq(sourceRevision.sourceId, sourceAttachmentIdentity.sourceId),
            eq(sourceRevision.revision, 1),
          ),
        )
        .where(
          and(
            eq(sourceAttachmentIdentity.organizationId, organizationId),
            eq(sourceAttachmentIdentity.sourceId, sourceId),
            eq(sourceAttachmentIdentity.attachmentId, attachmentId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}
