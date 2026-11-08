import type { Result, TenantContext } from "@relay/contracts";
import { createRetentionRepository, type Database } from "@relay/db";
import { createRedactionSigner } from "@relay/domain/core";
import { productFailure, readProductJson } from "./http.ts";
export function createRetentionHttp(db: Database, key: string | undefined) {
  const repo = createRetentionRepository(db);
  return async (
    context: TenantContext,
    path: string,
    request: Request,
  ): Promise<Result<unknown> | Response | null> => {
    if (
      !["retention-preview", "retention-ledger", "retention-redact"].includes(
        path,
      )
    )
      return null;
    const fail = (code: Parameters<typeof productFailure>[0]) =>
      productFailure(code, context.correlationId);
    if (request.method === "GET" && path === "retention-preview")
      return repo.previewExpiredEvidence(context);
    if (!key || key.length < 32) return fail("DEPENDENCY_UNAVAILABLE");
    const signer = createRedactionSigner(key);
    if (path === "retention-ledger" && request.method === "GET") {
      const result = await repo.listRedactionLedger(context);
      if (!result.ok) return result;
      return new Response(
        JSON.stringify(
          (() => {
            const data = {
              version: 1,
              scope: "organization",
              exportedAt: new Date().toISOString(),
              records: result.value.map((record) => ({
                record,
                signature: signer.sign(record),
              })),
            };
            return { ...data, manifestSignature: signer.signManifest(data) };
          })(),
          null,
          2,
        ),
        {
          headers: {
            "content-type": "application/json",
            "content-disposition": "attachment; filename=redaction-ledger.json",
            "cache-control": "no-store",
          },
        },
      );
    }
    if (path !== "retention-redact" || request.method !== "POST")
      return fail("NOT_FOUND");
    let body: unknown;
    try {
      body = await readProductJson(request);
    } catch {
      return fail("VALIDATION");
    }
    if (!body || typeof body !== "object") return fail("VALIDATION");
    const input = body as Record<string, unknown>;
    if (
      typeof input.sourceId !== "string" ||
      !Number.isInteger(input.expectedRevision) ||
      typeof input.idempotencyKey !== "string" ||
      typeof input.reason !== "string" ||
      !input.reason.trim()
    )
      return fail("VALIDATION");
    return repo.redactSource(context, {
      sourceId: input.sourceId,
      expectedRevision: Number(input.expectedRevision),
      idempotencyKey: input.idempotencyKey,
      reason: input.reason,
    });
  };
}
