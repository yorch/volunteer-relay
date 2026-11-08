import { createHash } from "node:crypto";
import {
  detectedImageMime,
  type PrivateBlobStore,
  withTrackedBlobWrites,
} from "@relay/blob";
import {
  type AttachmentStore,
  type AuthorizationService,
  REPORT_DETAIL_ACTIVITIES_LIMIT,
  REPORT_VOLUNTEERS_LIMIT,
  type Receipt,
  type Result,
  reportDetailWeekStarts,
  reportQuerySchema,
  reportWeekRange,
  type SourceRepository,
  type TenantContext,
} from "@relay/contracts";
import {
  createSourceStore,
  type Database,
  pruneUnreferencedBlob,
  sql,
} from "@relay/db";
import { canonicalDigest, createSourceRepository } from "@relay/domain/core";
import {
  createPhotoTransform,
  type ImportPreview,
  parseCsvImport,
  parseJsonImport,
  parseWhatsAppTextExport,
} from "@relay/intake";
import sharp from "sharp";
import { handleDemoReplay } from "./demo-replay.ts";
import { type ProductProcessing, productFailure } from "./http.ts";
import { prepareImportPhotos, readImportInput } from "./import-photos.ts";
import {
  buildProductReport,
  reportCsv,
  volunteerCsv,
  volunteerDetail,
} from "./report-csv.ts";

const photoTransform = createPhotoTransform(sharp);

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
export type TransactionalServices = {
  authorization?: AuthorizationService;
  processing?: Pick<ProductProcessing, "getSource">;
  timezone?: (organizationId: string) => Promise<string>;
};
export function createProductExtensions(options: {
  db: Database;
  authorization: AuthorizationService;
  sources: SourceRepository;
  processing: ProductProcessing;
  attachments: AttachmentStore;
  store: PrivateBlobStore;
  maxBytes: number;
  timezone?: (organizationId: string) => Promise<string>;
  /** Clock for the report's local week; defaults to the system time. */
  now?: () => Date;
  /**
   * Builds the services used inside a write transaction from that
   * transaction, so reads share its connection and snapshot instead of
   * borrowing a second pool connection. Omitted fields fall back to the
   * root-scoped options.
   */
  transactional?: (tx: Database) => TransactionalServices;
}) {
  const scoped = (tx: Database): Required<TransactionalServices> => {
    const built = options.transactional?.(tx) ?? {};
    return {
      authorization: built.authorization ?? options.authorization,
      processing: built.processing ?? options.processing,
      timezone:
        built.timezone ??
        (async (organizationId: string) =>
          (await options.timezone?.(organizationId)) ?? "UTC"),
    };
  };
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
      // `view` only selects the CSV shape; the echoed query never carries it,
      // so the default report and CSV stay exactly as before.
      const { view = "summary", ...q } = parsed.data;
      const volunteerCsvView = path === "reports.csv" && view === "volunteers";
      // The per-volunteer export is staff-only, checked before any lookup.
      if (volunteerCsvView) {
        const staffPermission = await options.authorization.require(
          context,
          "review:write",
        );
        if (!staffPermission.ok) return denied("FORBIDDEN");
      }
      const timezone =
        (await options.timezone?.(context.organizationId)) ?? "UTC";
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
        sql`select count(*) filter(where status not in ('resolved','cancelled'))::int as open, count(*) filter(where status='resolved')::int as resolved, count(*) filter(where status not in ('resolved','cancelled') and owner_membership_id is null)::int as unassigned, avg(extract(epoch from (acknowledged_at-created_at))/60) filter(where acknowledged_at is not null) as ack,avg(extract(epoch from (resolved_at-created_at))/60) filter(where resolved_at is not null) as resolution from need where organization_id=${context.organizationId} and (${q.from ?? null}::date is null or (created_at AT TIME ZONE ${timezone})::date >= ${q.from ?? null}::date) and (${q.to ?? null}::date is null or (created_at AT TIME ZONE ${timezone})::date <= ${q.to ?? null}::date)`,
      );
      const unknown = await options.db.execute(
        sql`select count(*)::int as count from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and a.local_date is null and (${q.program ?? null}::text is null or a.kind=${q.program ?? null}) and (${q.membershipId ?? null}::text is null or c.membership_id=${q.membershipId ?? null})`,
      );
      // The current local week ignores the from/to filter but keeps the
      // program and volunteer filters; unknown-date activities never count.
      const weekRange = reportWeekRange(
        timezone,
        options.now?.() ?? new Date(),
      );
      const week = weekRange
        ? await options.db.execute(
            sql`select coalesce(sum(c.duration_minutes),0)::int as minutes from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and a.local_date >= ${weekRange.from}::date and a.local_date <= ${weekRange.to}::date and (${q.program ?? null}::text is null or a.kind=${q.program ?? null}) and (${q.membershipId ?? null}::text is null or c.membership_id=${q.membershipId ?? null})`,
          )
        : null;
      // Per-member and queue facts need the staff permission that already
      // shows contributions and sources; aggregate-only readers never get them.
      const staff =
        volunteerCsvView ||
        (path === "reports" &&
          (await options.authorization.require(context, "review:write")).ok);
      const dashboard = staff && path === "reports";
      const contributors = dashboard
        ? await options.db.execute(
            sql`select c.membership_id, coalesce(sum(c.duration_minutes),0)::int as minutes, count(*)::int as approved from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and c.membership_id is not null and (${q.from ?? null}::date is null or a.local_date >= ${q.from ?? null}::date) and (${q.to ?? null}::date is null or a.local_date <= ${q.to ?? null}::date) and (${q.program ?? null}::text is null or a.kind=${q.program ?? null}) and (${q.membershipId ?? null}::text is null or c.membership_id=${q.membershipId ?? null}) group by c.membership_id order by minutes desc, approved desc, c.membership_id limit 5`,
          )
        : null;
      // Same current-queue predicate as ProcessingRepository.listQueue.
      const oldest = dashboard
        ? await options.db.execute(
            sql`select min(r.created_at) as oldest from extraction_run r where r.organization_id=${context.organizationId} and r.status='review' and r.generation=(select max(p.generation) from processing_policy_snapshot p where p.organization_id=r.organization_id and p.source_id=r.source_id and p.source_revision=r.source_revision) and not exists (select 1 from source_redaction z where z.organization_id=r.organization_id and z.source_id=r.source_id) and not exists (select 1 from source_revision newer where newer.organization_id=r.organization_id and newer.source_id=r.source_id and newer.revision>r.source_revision)`,
          )
        : null;
      // Staff volunteer roster: the totals query's from/to/program/volunteer
      // predicates, grouped per resolved member. Pending rows only count;
      // their minutes are never summed. The week column uses the same local
      // week as weekApprovedMinutes and ignores from/to. One extra row is
      // fetched so the mapper can flag truncation.
      const inRange = sql`(${q.from ?? null}::date is null or a.local_date >= ${q.from ?? null}::date) and (${q.to ?? null}::date is null or a.local_date <= ${q.to ?? null}::date)`;
      // The display name is resolved inside the same organization; a former
      // member (no current membership) has none.
      const roster = staff
        ? await options.db.execute(
            sql`select c.membership_id,
              (select u.name from member m join "user" u on u.id=m.user_id where m.organization_id=${context.organizationId} and m.id=c.membership_id) as volunteer_name,
              coalesce(sum(c.duration_minutes) filter(where c.status='approved' and ${inRange}),0)::int as minutes,
              count(*) filter(where c.status='approved' and ${inRange})::int as approved,
              count(*) filter(where c.status='pending' and ${inRange})::int as pending,
              count(*) filter(where c.status='pending' and c.duration_minutes is null and ${inRange})::int as unknown,
              coalesce(sum(c.duration_minutes) filter(where c.status='approved' and a.local_date >= ${weekRange?.from ?? null}::date and a.local_date <= ${weekRange?.to ?? null}::date),0)::int as week_minutes
            from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id
            where c.organization_id=${context.organizationId}
              and c.membership_id is not null
              and c.status in ('approved','pending')
              and (${q.program ?? null}::text is null or a.kind=${q.program ?? null})
              and (${q.membershipId ?? null}::text is null or c.membership_id=${q.membershipId ?? null})
            group by c.membership_id
            having count(*) filter(where ${inRange}) > 0
            order by minutes desc, c.membership_id collate "C"
            limit ${REPORT_VOLUNTEERS_LIMIT + 1}`,
          )
        : null;
      // Staff detail for the volunteer filter. The weekly trend covers the
      // last REPORT_DETAIL_WEEKS local weeks (program filter kept, from/to
      // ignored, unknown dates counted apart); byActivity keeps every filter.
      const member = dashboard ? q.membershipId : undefined;
      const program = sql`(${q.program ?? null}::text is null or a.kind=${q.program ?? null})`;
      const firstWeek = weekRange ? reportDetailWeekStarts(weekRange)[0] : null;
      const detailWeeks =
        member && weekRange && firstWeek
          ? await options.db.execute(
              sql`select (date_trunc('week', a.local_date::timestamp))::date::text as week_start, coalesce(sum(c.duration_minutes),0)::int as minutes from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and c.membership_id=${member} and a.local_date >= ${firstWeek}::date and a.local_date <= ${weekRange.to}::date and ${program} group by 1`,
            )
          : null;
      const detailUnknown = member
        ? await options.db.execute(
            sql`select count(*)::int as count from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and c.membership_id=${member} and a.local_date is null and ${program}`,
          )
        : null;
      const detailActivities = member
        ? await options.db.execute(
            sql`select a.id as activity_id, a.kind, a.local_date::text as local_date, coalesce(sum(c.duration_minutes),0)::int as minutes, count(*)::int as approved from contribution c join activity a on a.organization_id=c.organization_id and a.id=c.activity_id where c.organization_id=${context.organizationId} and c.status='approved' and c.membership_id=${member} and ${inRange} and ${program} group by a.id, a.kind, a.local_date order by minutes desc, a.id collate "C" limit ${REPORT_DETAIL_ACTIVITIES_LIMIT + 1}`,
          )
        : null;
      const value = buildProductReport({
        query: q,
        timezone,
        totals: r,
        needs: needs.rows[0] ?? {},
        unknownDate: unknown.rows[0] ?? {},
        weekRange,
        week: week ? (week.rows[0] ?? {}) : null,
        contributors: contributors ? contributors.rows : null,
        oldestQueued: oldest ? (oldest.rows[0] ?? {}) : null,
        volunteers: roster ? roster.rows : null,
        volunteerDetail:
          member && detailUnknown && detailActivities
            ? volunteerDetail({
                membershipId: member,
                weekRange,
                weeks: detailWeeks ? detailWeeks.rows : [],
                unknownDate: detailUnknown.rows[0] ?? {},
                activities: detailActivities.rows,
              })
            : null,
      });
      if (volunteerCsvView) {
        const names = new Map<string, string>();
        for (const row of roster?.rows ?? []) {
          if (
            typeof row.membership_id === "string" &&
            typeof row.volunteer_name === "string"
          )
            names.set(row.membership_id, row.volunteer_name);
        }
        return new Response(volunteerCsv(value.volunteers ?? [], names), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": "attachment; filename=volunteer-hours.csv",
            "cache-control": "no-store",
            "x-report-truncated": String(value.volunteersTruncated === true),
          },
        });
      }
      if (path === "reports.csv") {
        return new Response(reportCsv(value), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": "attachment; filename=volunteer-report.csv",
            "cache-control": "no-store",
          },
        });
      }
      return { ok: true, value };
    }
    if (path === "demo-replay")
      return handleDemoReplay(context, request, options);
    if (path.startsWith("attachments/") && request.method === "GET") {
      const parts = path.split("/");
      if (parts.length !== 3) return denied("NOT_FOUND");
      let sourceId: string, attachmentId: string;
      try {
        sourceId = decodeURIComponent(parts[1] ?? "");
        attachmentId = decodeURIComponent(parts[2] ?? "");
      } catch {
        // Malformed percent-encoding is a client error, not an outage.
        return denied("VALIDATION");
      }
      const result = await options.attachments.read(
        context,
        sourceId,
        attachmentId,
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
          const raw = Buffer.from(await file.arrayBuffer());
          if (!detectedImageMime(raw)) return denied("VALIDATION");
          pixels = await photoTransform(raw);
        } catch {
          return denied("VALIDATION");
        }
        const actor = context.actor;
        const digest = createHash("sha256").update(pixels).digest("hex");
        const storageKey = `${digest.slice(0, 2)}/${digest}`;
        return withTrackedBlobWrites(
          options.store,
          async (note) =>
            options.db.transaction(async (tx) => {
              const services = scoped(tx as unknown as Database);
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${storageKey}`},0))`,
              );
              const tombstone = await tx.execute(
                sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${sourceId}`,
              );
              if (tombstone.rows.length) return denied("NOT_FOUND");
              const repository = createSourceRepository({
                authorization: services.authorization,
                store: createSourceStore(tx as unknown as Database),
              });
              await note({ storageKey, sha256: digest });
              const blob = await options.store.put(pixels);
              const old = await services.processing.getSource(
                context,
                sourceId,
              );
              if (old.ok) {
                if (
                  old.value.text !== text ||
                  old.value.attachments[0]?.sha256 !== blob.sha256
                )
                  return denied("CONFLICT");
                return repository.accept(context, old.value);
              }
              if (old.error.code !== "NOT_FOUND") return old;
              return repository.accept(context, {
                schemaVersion: 1,
                organizationId: context.organizationId,
                sourceId,
                revision: 1,
                channel: "web",
                channelIdentity: actor.membershipId,
                externalMessageId: sourceId,
                idempotencyKey: key,
                author: {
                  externalIdentity: actor.userId,
                  membershipId: actor.membershipId,
                },
                occurredAt: null,
                receivedAt: new Date().toISOString(),
                timezone: await services.timezone(context.organizationId),
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
            }),
          (identity, done) =>
            pruneUnreferencedBlob(
              options.db,
              identity,
              (key, sha) => options.store.erase(key, sha),
              done,
            ),
        );
      }
      let input: Record<string, unknown>;
      let files: Map<string, File>;
      try {
        ({ input, files } = await readImportInput(request, options.maxBytes));
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
      let preview: ImportPreview =
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
      const prepared = await prepareImportPhotos(
        preview,
        input,
        files,
        context.organizationId,
        options.maxBytes,
      );
      preview = prepared.preview;
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
        return await withTrackedBlobWrites(
          options.store,
          async (note) =>
            options.db.transaction(async (tx) => {
              const services = scoped(tx as unknown as Database);
              const repository = createSourceRepository({
                authorization: services.authorization,
                store: createSourceStore(tx as unknown as Database),
              });
              const receipts: Receipt[] = [];
              for (const blob of [...prepared.blobs].sort((a, b) =>
                a.metadata.storageKey.localeCompare(b.metadata.storageKey),
              )) {
                await tx.execute(
                  sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${blob.metadata.storageKey}`},0))`,
                );
              }
              for (const source of preview.sources) {
                const hidden = await tx.execute(
                  sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${source.sourceId}`,
                );
                if (hidden.rows.length)
                  throw new ImportRollback(denied("NOT_FOUND"));
              }
              for (const blob of prepared.blobs) {
                await note(blob.metadata);
                await options.store.put(blob.content);
              }
              for (const source of preview.sources) {
                const old = await services.processing.getSource(
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
            }),
          (identity, done) =>
            pruneUnreferencedBlob(
              options.db,
              identity,
              (key, sha) => options.store.erase(key, sha),
              done,
            ),
        );
      } catch (error) {
        if (error instanceof ImportRollback) return error.result;
        throw error;
      }
    }
    return null;
  };
}
