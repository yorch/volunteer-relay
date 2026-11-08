import { z } from "zod";
export const redactionLedgerRecordSchema = z
  .object({
    organizationId: z.string().min(1),
    sourceId: z.string().min(1),
    latestRevision: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    redactionId: z.string().min(1),
    reasonHash: z.string().regex(/^[a-f0-9]{64}$/),
    redactedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type RedactionLedgerRecord = z.infer<typeof redactionLedgerRecordSchema>;
export const signedRedactionLedgerSchema = z
  .object({
    version: z.literal(1),
    scope: z.enum(["organization", "deployment"]),
    exportedAt: z.iso.datetime({ offset: true }),
    manifestSignature: z.string().regex(/^[a-f0-9]{64}$/),
    records: z
      .array(
        z
          .object({
            record: redactionLedgerRecordSchema,
            signature: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(50000),
  })
  .strict();
