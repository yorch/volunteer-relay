import { createHash } from "node:crypto";
import {
  type AttachmentStore,
  type AuthorizationService,
  type ProductReport,
  type Receipt,
  type Result,
  reportQuerySchema,
  type SourceRepository,
  type TenantContext,
} from "@relay/contracts";
import { createSourceStore, type Database, sql } from "@relay/db";
import { canonicalDigest, createSourceRepository } from "@relay/domain/core";
import {
  createPrivateFilesystemBlobStore,
  type ImportPreview,
  parseCsvImport,
  parseJsonImport,
  parseWhatsAppTextExport,
} from "@relay/intake";
import sharp from "sharp";
import { type ProductProcessing, productFailure } from "./http.ts";

export { readPrivateBlob } from "@relay/intake";

async function bodyBytes(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error("limit");
      }
      chunks.push(p.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const text = /^[=+@\-\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${text.replaceAll('"', '""')}"`;
}
export function createProductExtensions(options: {
  db: Database;
  authorization: AuthorizationService;
  sources: SourceRepository;
  processing: ProductProcessing;
  attachments: AttachmentStore;
  root: string;
  maxBytes: number;
}) {
  return async (
    context: TenantContext,
    path: string,
    request: Request,
  ): Promise<Result<unknown> | Response | null> => {
    const denied = (code: Parameters<typeof productFailure>[0]) =>
      productFailure(code, context.correlationId);
    if (path === "reports" || path === "reports.csv") {
      if (request.method !== "GET") return denied("NOT_FOUND");
      const permission = await options.authorization.require(
        context,
        "report:read",
      );
      if (!permission.ok) return permission;
      const parsed = reportQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!parsed.success) return denied("VALIDATION");
      const q = parsed.data;
      const result = await options.db.execute(sql`
        select coalesce(sum(c.duration_minutes) filter(where c.status='approved'),0)::int as minutes,
          count(*) filter(where c.status='approved')::int as approved,
          count(distinct c.activity_id) filter(where c.status='approved')::int as visits,
          count(*) filter(where c.status='pending')::int as pending,
          count(*) filter(where c.status='pending' and c.duration_minutes is null)::int as unknown,
          count(*) filter(where c.status='pending' and c.membership_id is null)::int as unresolved
        from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id
        where c.organization_id=${context.organizationId}
          and (${q.from ?? null}::date is null or a.local_date >= ${q.from ?? null}::date)
          and (${q.to ?? null}::date is null or a.local_date <= ${q.to ?? null}::date)
          and (${q.program ?? null}::text is null or a.kind=${q.program ?? null})
          and (${q.membershipId ?? null}::text is null or c.membership_id=${q.membershipId ?? null})`);
      const r = result.rows[0] ?? {};
      const needs = await options.db.execute(
        sql`select count(*) filter(where status not in ('resolved','cancelled'))::int as open, count(*) filter(where status='resolved')::int as resolved, avg(extract(epoch from (acknowledged_at-created_at))/60) filter(where acknowledged_at is not null) as ack from need where organization_id=${context.organizationId} and (${q.from ?? null}::date is null or (created_at AT TIME ZONE 'UTC')::date >= ${q.from ?? null}::date) and (${q.to ?? null}::date is null or (created_at AT TIME ZONE 'UTC')::date <= ${q.to ?? null}::date)`,
      );
      const unknown = await options.db.execute(
        sql`select count(*)::int as count from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and a.local_date is null and (${q.program ?? null}::text is null or a.kind=${q.program ?? null}) and (${q.membershipId ?? null}::text is null or c.membership_id=${q.membershipId ?? null})`,
      );
      const n = needs.rows[0] ?? {};
      const value: ProductReport = {
        query: q,
        timezone: "UTC",
        ledger: {
          approvedMinutes: Number(r.minutes ?? 0),
          approvedContributions: Number(r.approved ?? 0),
          activitiesWithApprovedContributions: Number(r.visits ?? 0),
          pendingContributions: Number(r.pending ?? 0),
          pendingUnknownDuration: Number(r.unknown ?? 0),
          pendingUnresolvedVolunteer: Number(r.unresolved ?? 0),
        },
        approvedHours: Number(r.minutes ?? 0) / 60,
        openNeeds: Number(n.open ?? 0),
        resolvedNeeds: Number(n.resolved ?? 0),
        averageAcknowledgmentMinutes: n.ack == null ? null : Number(n.ack),
        excludedUnknownDate:
          q.from || q.to ? Number(unknown.rows[0]?.count ?? 0) : 0,
      };
      if (path === "reports.csv") {
        const fields = {
          timezone: value.timezone,
          from: q.from ?? "",
          to: q.to ?? "",
          program: q.program ?? "",
          membershipId: q.membershipId ?? "",
          ...value.ledger,
          approvedHours: value.approvedHours,
          openNeeds: value.openNeeds,
          resolvedNeeds: value.resolvedNeeds,
          averageAcknowledgmentMinutes: value.averageAcknowledgmentMinutes,
          excludedUnknownDate: value.excludedUnknownDate,
        };
        return new Response(
          Object.keys(fields).map(csvCell).join(",") +
            "\r\n" +
            Object.values(fields).map(csvCell).join(",") +
            "\r\n",
          {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition":
                "attachment; filename=volunteer-report.csv",
              "cache-control": "no-store",
            },
          },
        );
      }
      return { ok: true, value };
    }
    if (path.startsWith("attachments/") && request.method === "GET") {
      const parts = path.split("/");
      if (parts.length !== 3) return denied("NOT_FOUND");
      const result = await options.attachments.read(
        context,
        decodeURIComponent(parts[1] ?? ""),
        decodeURIComponent(parts[2] ?? ""),
      );
      if (!result.ok) return result;
      return new Response(Buffer.from(result.value.bytes), {
        headers: {
          "content-type": result.value.mimeType,
          "cache-control": "no-store",
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (["import-preview", "import", "source-photo"].includes(path)) {
      if (request.method !== "POST" || context.actor.kind !== "user")
        return denied("FORBIDDEN");
      const permission = await options.authorization.require(
        context,
        path === "source-photo" ? "source:submit" : "review:write",
      );
      if (!permission.ok) return permission;
      if (path === "source-photo") {
        let form: FormData;
        try {
          const bytes = await bodyBytes(request, options.maxBytes + 65536);
          form = await new Response(bytes, {
            headers: {
              "content-type": request.headers.get("content-type") ?? "",
            },
          }).formData();
        } catch {
          return denied("VALIDATION");
        }
        const file = form.get("file"),
          text = form.get("text"),
          key = form.get("idempotencyKey");
        if (
          !(file instanceof File) ||
          typeof text !== "string" ||
          text.length > 20000 ||
          typeof key !== "string" ||
          !key ||
          key.length > 200 ||
          file.size > options.maxBytes
        )
          return denied("VALIDATION");
        const sourceId = createHash("sha256")
          .update(
            JSON.stringify([
              context.organizationId,
              context.actor.membershipId,
              key,
            ]),
          )
          .digest("hex");
        let pixels: Buffer;
        try {
          pixels = await sharp(Buffer.from(await file.arrayBuffer()), {
            limitInputPixels: 40000000,
            failOn: "warning",
          })
            .rotate()
            .resize({
              width: 2000,
              height: 2000,
              fit: "inside",
              withoutEnlargement: true,
            })
            .png()
            .toBuffer();
        } catch {
          return denied("VALIDATION");
        }
        const blob = await createPrivateFilesystemBlobStore(options.root, {
          maxBytes: options.maxBytes,
        }).put(pixels);
        const old = await options.processing.getSource(context, sourceId);
        if (old.ok) {
          if (
            old.value.text !== text ||
            old.value.attachments[0]?.sha256 !== blob.sha256
          )
            return denied("CONFLICT");
          return options.sources.accept(context, old.value);
        }
        if (old.error.code !== "NOT_FOUND") return old;
        return options.sources.accept(context, {
          schemaVersion: 1,
          organizationId: context.organizationId,
          sourceId,
          revision: 1,
          channel: "web",
          channelIdentity: context.actor.membershipId,
          externalMessageId: sourceId,
          idempotencyKey: key,
          author: {
            externalIdentity: context.actor.userId,
            membershipId: context.actor.membershipId,
          },
          occurredAt: null,
          receivedAt: new Date().toISOString(),
          timezone: "UTC",
          text,
          attachments: [
            {
              ...blob,
              id: `photo:${blob.sha256}`,
              organizationId: context.organizationId,
            },
          ],
          replyToSourceId: null,
          replacesRevision: null,
          original: { mediaType: "text/plain", payload: text },
        });
      }
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(
          (await bodyBytes(request, 5 * 1024 * 1024)).toString("utf8"),
        );
      } catch {
        return denied("VALIDATION");
      }
      if (
        !input ||
        typeof input !== "object" ||
        typeof input.text !== "string" ||
        typeof input.timezone !== "string" ||
        !["json", "csv", "whatsapp"].includes(String(input.format)) ||
        !["ISO", "YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"].includes(
          String(input.dateFormat),
        )
      )
        return denied("VALIDATION");
      const mapping = input.authorMapping;
      if (
        !mapping ||
        typeof mapping !== "object" ||
        Array.isArray(mapping) ||
        Object.values(mapping).some((v) => v !== null && typeof v !== "string")
      )
        return denied("VALIDATION");
      const currentMembers = await options.db.execute(
        sql`select id from member where organization_id=${context.organizationId}`,
      );
      const memberIds = new Set(currentMembers.rows.map((m) => m.id));
      if (Object.values(mapping).some((v) => v !== null && !memberIds.has(v)))
        return denied("VALIDATION");
      const ctx = {
        organizationId: context.organizationId,
        importerIdentity: context.actor.membershipId,
        authorByExternalIdentity: mapping as Record<string, string | null>,
        timezone: input.timezone,
        receivedAt: new Date().toISOString(),
        channelIdentity: "staff-import",
      };
      const format = input.dateFormat as
        | "ISO"
        | "YYYY-MM-DD"
        | "MM/DD/YYYY"
        | "DD/MM/YYYY";
      const preview: ImportPreview =
        input.format === "whatsapp"
          ? parseWhatsAppTextExport(input.text, ctx, {
              dateOrder: format === "DD/MM/YYYY" ? "DMY" : "MDY",
              receivedAt: ctx.receivedAt,
            })
          : (input.format === "csv" ? parseCsvImport : parseJsonImport)(
              input.text,
              ctx,
              {
                mapping: {
                  externalId: "id",
                  author: "author",
                  text: "text",
                  timestamp: "timestamp",
                },
                dateFormat: format,
              },
            );
      if (path === "import-preview") return { ok: true, value: preview };
      if (
        preview.errors.length ||
        (preview.ambiguousDuplicates.length && input.allowAmbiguous !== true)
      )
        return denied("VALIDATION");
      // Distinct content under one external identity cannot be confirmed as
      // an ambiguous duplicate: staff must resolve the import first.
      const unique = new Map<string, string>();
      for (const source of preview.sources) {
        const digest = canonicalDigest(source);
        const prior = unique.get(source.sourceId);
        if (prior && prior !== digest) return denied("CONFLICT");
        unique.set(source.sourceId, digest);
      }
      class ImportRollback extends Error {
        readonly result: Result<never>;
        constructor(result: Result<never>) {
          super("Import rolled back");
          this.result = result;
        }
      }
      try {
        return await options.db.transaction(async (tx) => {
          const repository = createSourceRepository({
            authorization: options.authorization,
            store: createSourceStore(tx as unknown as Database),
          });
          const receipts: Receipt[] = [];
          for (const source of preview.sources) {
            const old = await options.processing.getSource(
              context,
              source.sourceId,
            );
            if (old.ok) source.receivedAt = old.value.receivedAt;
            else if (old.error.code !== "NOT_FOUND")
              throw new ImportRollback(old);
            const accepted = await repository.accept(context, source);
            if (!accepted.ok) throw new ImportRollback(accepted);
            receipts.push(accepted.value);
          }
          return { ok: true as const, value: { receipts } };
        });
      } catch (error) {
        if (error instanceof ImportRollback) return error.result;
        throw error;
      }
    }
    return null;
  };
}
