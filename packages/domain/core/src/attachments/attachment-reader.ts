import { createHash } from "node:crypto";
import type { AttachmentStore, AuthorizationService } from "@relay/contracts";
import type { AttachmentMetadataStore } from "../domain-store.ts";
import { failure } from "../shared/failure.ts";

export interface AttachmentBlobReader {
  read(storageKey: string): Promise<Uint8Array | null>;
}

export interface AttachmentReaderDependencies {
  authorization: AuthorizationService;
  metadata: AttachmentMetadataStore;
  blobs: AttachmentBlobReader;
}

/**
 * Tenant-authorized attachment reads (ADR 0009). Access rules mirror
 * SourceRepository.get evidence rules: staff read any attachment in the
 * tenant; a volunteer reads only attachments of sources they authored;
 * report-readers and system actors are denied before any lookup. Blob bytes
 * are verified against the stored byte length and SHA-256.
 */
export function createAttachmentReader({
  authorization,
  metadata,
  blobs,
}: AttachmentReaderDependencies): AttachmentStore {
  return {
    async read(context, sourceId, attachmentId) {
      const correlationId = context.correlationId || "-";
      if (context.actor.kind === "system")
        return failure(
          "FORBIDDEN",
          "System actor cannot read source evidence",
          correlationId,
        );

      const staff = await authorization.require(context, "review:write");
      if (!staff.ok) {
        if (staff.error.code !== "FORBIDDEN") return staff;
        // A report-reader holds report:read only and gets no evidence access;
        // the denial happens before any existence lookup or blob read.
        const submit = await authorization.require(context, "source:submit");
        if (!submit.ok && submit.error.code !== "FORBIDDEN") return submit;
        if (!submit.ok)
          return failure(
            "FORBIDDEN",
            "Role does not grant source evidence access",
            correlationId,
          );
      }

      let stored: Awaited<ReturnType<AttachmentMetadataStore["find"]>>;
      try {
        stored = await metadata.find(
          context.organizationId,
          sourceId,
          attachmentId,
        );
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Attachment metadata is unavailable",
          correlationId,
          true,
        );
      }
      if (!stored)
        return failure("NOT_FOUND", "Attachment not found", correlationId);

      // An authorized non-staff reader gets NOT_FOUND for someone else's
      // source, exactly like an unknown or cross-tenant id.
      if (!staff.ok && stored.authorMembershipId !== context.actor.membershipId)
        return failure("NOT_FOUND", "Attachment not found", correlationId);

      let bytes: Uint8Array | null;
      try {
        bytes = await blobs.read(stored.storageKey);
      } catch {
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Attachment bytes are unavailable",
          correlationId,
          true,
        );
      }
      if (bytes === null)
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Attachment bytes are unavailable",
          correlationId,
          true,
        );

      const digest = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length !== stored.bytes || digest !== stored.sha256)
        // Stored metadata disagrees with blob bytes: not retryable, no detail.
        return failure(
          "DEPENDENCY_UNAVAILABLE",
          "Attachment bytes are unavailable",
          correlationId,
        );

      return { ok: true, value: { bytes, mimeType: stored.mimeType } };
    },
  };
}
