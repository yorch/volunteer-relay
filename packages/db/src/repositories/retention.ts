import { createHash, randomUUID } from "node:crypto";
import type { Result, TenantContext } from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../types.ts";

type Executor = Pick<Database, "execute">;
export interface RedactionLedgerRecord {
  organizationId: string;
  sourceId: string;
  latestRevision: number;
  sourceDigest: string;
  redactionId: string;
  reasonHash: string;
  redactedAt: string;
}
export interface ErasureClaim {
  jobId: string;
  storageKey: string;
  sha256: string;
  leaseToken: string;
}
type Options = {
  now?: () => Date;
  verifyRedactionLedger?: (
    record: RedactionLedgerRecord,
    signature: string,
  ) => boolean | Promise<boolean>;
};
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
function fail(
  c: Pick<TenantContext, "correlationId">,
  code:
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "CONFLICT"
    | "VALIDATION"
    | "DEPENDENCY_UNAVAILABLE",
  message: string,
): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      correlationId: c.correlationId || "-",
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}
class Stop extends Error {
  readonly code: "NOT_FOUND" | "CONFLICT" | "VALIDATION";
  constructor(code: "NOT_FOUND" | "CONFLICT" | "VALIDATION", message: string) {
    super(message);
    this.code = code;
  }
}
const error = (c: Pick<TenantContext, "correlationId">, e: unknown) =>
  e instanceof Stop
    ? fail(c, e.code, e.message)
    : fail(c, "DEPENDENCY_UNAVAILABLE", "Retention storage unavailable");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function owner(db: Executor, c: TenantContext): Promise<boolean> {
  if (c.actor.kind !== "user") return false;
  const rows = await db.execute(
    sql`select 1 from member where organization_id=${c.organizationId} and id=${c.actor.membershipId} and user_id=${c.actor.userId} and role='owner' for share`,
  );
  return rows.rows.length > 0;
}
async function applyRedaction(
  tx: Executor,
  organizationId: string,
  sourceId: string,
  time: Date,
): Promise<void> {
  const attachments = await tx.execute(
    sql`select distinct storage_key,sha256 from source_attachment_identity where organization_id=${organizationId} and source_id=${sourceId} order by storage_key`,
  );
  for (const a of attachments.rows) {
    const key = a.storage_key as string;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('blob:' || ${key},0))`,
    );
    const conflict = await tx.execute(
      sql`select 1 from source_attachment_identity where storage_key=${key} and sha256<>${a.sha256 as string} limit 1`,
    );
    if (conflict.rows.length)
      throw new Stop("CONFLICT", "Attachment identity is inconsistent");
    await tx.execute(
      sql`insert into blob_erasure_job(storage_key,sha256,completed,attempts,created_at,updated_at) values (${key},${a.sha256 as string},false,0,${time},${time}) on conflict(storage_key) do update set completed=false,attempts=0,lease_token=null,lease_until=null,retry_after=null,updated_at=excluded.updated_at`,
    );
  }
  await tx.execute(
    sql`update source_revision set text_body='',original_payload='',author_external_identity='[redacted]',envelope='{"redacted":true}'::jsonb where organization_id=${organizationId} and source_id=${sourceId}`,
  );
  await tx.execute(
    sql`update extraction_run set proposal='{"redacted":true}'::jsonb where organization_id=${organizationId} and source_id=${sourceId}`,
  );
  await tx.execute(
    sql`update review_decision d set command='{"redacted":true}'::jsonb from extraction_run e where e.organization_id=${organizationId} and e.source_id=${sourceId} and (d.organization_id,d.run_id)=(e.organization_id,e.run_id)`,
  );
  await tx.execute(
    sql`update review_effect f set item_key='redacted:'||encode(sha256(convert_to(f.item_key,'UTF8')),'hex') from extraction_run e where e.organization_id=${organizationId} and e.source_id=${sourceId} and (f.organization_id,f.run_id)=(e.organization_id,e.run_id)`,
  );
  await tx.execute(
    sql`update activity set beneficiary_reference=null,kind='[redacted]' where organization_id=${organizationId} and origin_kind='source' and origin_source_id=${sourceId}`,
  );
  await tx.execute(
    sql`update need set summary='[redacted]',category='[redacted]',resolution=case when resolution is null then null else '[redacted]' end where organization_id=${organizationId} and origin_kind='source' and origin_source_id=${sourceId}`,
  );
  await tx.execute(
    sql`update domain_audit_event a set before=relay_redact_record(a.before),after=relay_redact_record(a.after),reason=case when a.reason is null then null else '[redacted]' end where a.organization_id=${organizationId} and relay_aggregate_redacted(a.organization_id,a.aggregate_type,a.aggregate_id)`,
  );
  await tx.execute(
    sql`update domain_command d set result=relay_redact_record(d.result) where d.organization_id=${organizationId} and jsonb_path_exists(d.result,'$.** ? (@.sourceId == $id)',jsonb_build_object('id',${sourceId}::text))`,
  );
  await tx.execute(
    sql`delete from processing_work where organization_id=${organizationId} and source_id=${sourceId}`,
  );
}
export function createRetentionRepository(
  db: Database,
  { now = () => new Date(), verifyRedactionLedger }: Options = {},
) {
  return {
    async previewExpiredEvidence(
      context: TenantContext,
      at: Date = now(),
    ): Promise<
      Result<{
        cutoff: string;
        truncated: boolean;
        sources: Array<{
          sourceId: string;
          latestRevision: number;
          expiredRevisions: number;
          attachmentCount: number;
        }>;
      }>
    > {
      if (!(at instanceof Date) || Number.isNaN(at.getTime()))
        return fail(context, "VALIDATION", "Invalid preview time");
      try {
        return await db.transaction(async (tx) => {
          if (!(await owner(tx, context)))
            return fail(context, "FORBIDDEN", "Owner authority required");
          const settings = await tx.execute(
            sql`select retention_days from organization_settings where organization_id=${context.organizationId}`,
          );
          const days =
            (settings.rows[0]?.retention_days as number | undefined) ?? 365;
          const cutoff = new Date(at.getTime() - days * 86400000);
          const rows = await tx.execute(
            sql`select s.source_id,max(s.revision)::int revision,count(*)::int revisions,(select count(*)::int from source_attachment_identity a where a.organization_id=s.organization_id and a.source_id=s.source_id) attachments from source_revision s where s.organization_id=${context.organizationId} and not exists(select 1 from source_redaction z where z.organization_id=s.organization_id and z.source_id=s.source_id) group by s.organization_id,s.source_id having max(s.received_at)<${cutoff} order by s.source_id limit 501`,
          );
          return ok({
            cutoff: cutoff.toISOString(),
            truncated: rows.rows.length > 500,
            sources: rows.rows.slice(0, 500).map((r) => ({
              sourceId: r.source_id as string,
              latestRevision: r.revision as number,
              expiredRevisions: r.revisions as number,
              attachmentCount: r.attachments as number,
            })),
          });
        });
      } catch (e) {
        return error(context, e);
      }
    },
    async redactSource(
      context: TenantContext,
      input: {
        sourceId: string;
        expectedRevision: number;
        idempotencyKey: string;
        reason: string;
      },
    ): Promise<Result<{ redactionId: string }>> {
      if (
        !input?.sourceId ||
        !input.idempotencyKey ||
        !input.reason?.trim() ||
        input.reason.length > 2000 ||
        !Number.isInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      )
        return fail(context, "VALIDATION", "Invalid redaction command");
      try {
        return await db.transaction(async (tx) => {
          if (!(await owner(tx, context)))
            return fail(context, "FORBIDDEN", "Owner authority required");
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([context.organizationId, "redaction", input.idempotencyKey])},0))`,
          );
          const replay = await tx.execute(
            sql`select source_id,expected_revision,reason,redaction_id from source_redaction where organization_id=${context.organizationId} and idempotency_key=${input.idempotencyKey}`,
          );
          if (replay.rows[0]) {
            const r = replay.rows[0];
            if (
              r.source_id !== input.sourceId ||
              r.expected_revision !== input.expectedRevision ||
              r.reason !== input.reason
            )
              throw new Stop("CONFLICT", "Idempotency key already used");
            return ok({ redactionId: r.redaction_id as string });
          }
          const locked = await tx.execute(
            sql`select id from source where organization_id=${context.organizationId} and id=${input.sourceId} for update`,
          );
          if (!locked.rows.length)
            throw new Stop("NOT_FOUND", "Source not found");
          const previous = await tx.execute(
            sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${input.sourceId}`,
          );
          if (previous.rows.length)
            throw new Stop("CONFLICT", "Source already redacted");
          const current = await tx.execute(
            sql`select revision,canonical_digest from source_revision where organization_id=${context.organizationId} and source_id=${input.sourceId} order by revision desc limit 1`,
          );
          const row = current.rows[0];
          if (!row) throw new Stop("NOT_FOUND", "Source not found");
          if (row.revision !== input.expectedRevision)
            throw new Stop("CONFLICT", "Source revision changed");
          const settings = await tx.execute(
            sql`select retention_days from organization_settings where organization_id=${context.organizationId} for share`,
          );
          const days =
            (settings.rows[0]?.retention_days as number | undefined) ?? 365;
          const time = now();
          const cutoff = new Date(time.getTime() - days * 86400000);
          const unexpired = await tx.execute(
            sql`select 1 from source_revision where organization_id=${context.organizationId} and source_id=${input.sourceId} and received_at>=${cutoff} limit 1`,
          );
          if (unexpired.rows.length)
            throw new Stop(
              "CONFLICT",
              "Source retention period has not expired",
            );
          const id = randomUUID();
          await tx.execute(
            sql`insert into source_redaction(organization_id,source_id,redaction_id,expected_revision,idempotency_key,reason,reason_hash,source_digest,actor,correlation_id,redacted_at) values (${context.organizationId},${input.sourceId},${id},${input.expectedRevision},${input.idempotencyKey},${input.reason},${sha(input.reason)},${row.canonical_digest as string},${JSON.stringify(context.actor)}::jsonb,${context.correlationId},${time})`,
          );
          await applyRedaction(
            tx,
            context.organizationId,
            input.sourceId,
            time,
          );
          return ok({ redactionId: id });
        });
      } catch (e) {
        return error(context, e);
      }
    },
    async listRedactionLedger(
      context: TenantContext,
    ): Promise<Result<RedactionLedgerRecord[]>> {
      try {
        return await db.transaction(async (tx) => {
          if (!(await owner(tx, context)))
            return fail(context, "FORBIDDEN", "Owner authority required");
          const rows = await tx.execute(
            sql`select organization_id,source_id,expected_revision,source_digest,redaction_id,reason_hash,redacted_at from source_redaction where organization_id=${context.organizationId} order by redacted_at,redaction_id`,
          );
          return ok(
            rows.rows.map((r) => ({
              organizationId: r.organization_id as string,
              sourceId: r.source_id as string,
              latestRevision: r.expected_revision as number,
              sourceDigest: r.source_digest as string,
              redactionId: r.redaction_id as string,
              reasonHash: r.reason_hash as string,
              redactedAt: new Date(r.redacted_at as string).toISOString(),
            })),
          );
        });
      } catch (e) {
        return error(context, e);
      }
    },
    async restoreRedactionLedger(
      record: RedactionLedgerRecord,
      signature: string,
    ): Promise<Result<void>> {
      const context = { correlationId: "retention-restore" };
      if (
        !verifyRedactionLedger ||
        !signature ||
        !record?.organizationId ||
        !record.sourceId ||
        !record.redactionId ||
        !Number.isInteger(record.latestRevision) ||
        record.latestRevision < 1 ||
        !/^[a-f0-9]{64}$/.test(record.sourceDigest) ||
        !/^[a-f0-9]{64}$/.test(record.reasonHash) ||
        Number.isNaN(Date.parse(record.redactedAt))
      )
        return fail(context, "VALIDATION", "Invalid signed redaction record");
      try {
        if (!(await verifyRedactionLedger(record, signature)))
          return fail(context, "FORBIDDEN", "Redaction signature invalid");
        return await db.transaction(async (tx) => {
          const lock = await tx.execute(
            sql`select id from source where organization_id=${record.organizationId} and id=${record.sourceId} for update`,
          );
          if (!lock.rows.length)
            throw new Stop("NOT_FOUND", "Source not found");
          const source = await tx.execute(
            sql`select revision,canonical_digest,received_at,envelope from source_revision where organization_id=${record.organizationId} and source_id=${record.sourceId} order by revision desc limit 1`,
          );
          const row = source.rows[0];
          if (
            !row ||
            row.revision !== record.latestRevision ||
            row.canonical_digest !== record.sourceDigest ||
            new Date(row.received_at as string) >= new Date(record.redactedAt)
          )
            throw new Stop("CONFLICT", "Restore source does not match ledger");
          const previous = await tx.execute(
            sql`select redaction_id,source_digest,expected_revision from source_redaction where organization_id=${record.organizationId} and source_id=${record.sourceId}`,
          );
          if (previous.rows[0]) {
            const existing = previous.rows[0];
            if (
              existing.redaction_id !== record.redactionId ||
              existing.source_digest !== record.sourceDigest ||
              existing.expected_revision !== record.latestRevision ||
              JSON.stringify(row.envelope) !==
                JSON.stringify({ redacted: true })
            )
              throw new Stop("CONFLICT", "Existing redaction differs");
            return ok(undefined);
          }
          const time = new Date(record.redactedAt);
          await tx.execute(
            sql`insert into source_redaction(organization_id,source_id,redaction_id,expected_revision,idempotency_key,reason,reason_hash,source_digest,actor,correlation_id,redacted_at) values (${record.organizationId},${record.sourceId},${record.redactionId},${record.latestRevision},${`restore:${record.redactionId}`},'[restored redaction]',${record.reasonHash},${record.sourceDigest},'{"kind":"system","service":"scheduler"}'::jsonb,'retention-restore',${time})`,
          );
          await applyRedaction(
            tx,
            record.organizationId,
            record.sourceId,
            now(),
          );
          return ok(undefined);
        });
      } catch (e) {
        return error(context, e);
      }
    },
    async claimErasureJobs(limit: number): Promise<ErasureClaim[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid erasure batch limit");
      try {
        return await db.transaction(async (tx) => {
          const time = now();
          const rows = await tx.execute(
            sql`with picked as (select j.storage_key from blob_erasure_job j where not j.completed and (j.lease_until is null or j.lease_until<=${time}) and (j.retry_after is null or j.retry_after<=${time}) and not exists (select 1 from source_attachment_identity a where a.storage_key=j.storage_key and not exists(select 1 from source_redaction r where r.organization_id=a.organization_id and r.source_id=a.source_id)) order by j.created_at,j.storage_key for update of j skip locked limit ${limit}), claimed as (update blob_erasure_job j set lease_token=gen_random_uuid()::text,lease_until=${time}::timestamptz+interval '5 minutes',attempts=j.attempts+1,updated_at=${time} from picked p where j.storage_key=p.storage_key returning j.*) select * from claimed`,
          );
          return rows.rows.map((r) => ({
            jobId: r.storage_key as string,
            storageKey: r.storage_key as string,
            sha256: r.sha256 as string,
            leaseToken: r.lease_token as string,
          }));
        });
      } catch {
        throw new Error("Retention storage unavailable");
      }
    },
    async runErasureJob(
      job: ErasureClaim,
      erase: (storageKey: string, sha256: string) => Promise<void>,
    ): Promise<boolean> {
      try {
        return await db.transaction(async (tx) => {
          const time = now();
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended('blob:' || ${job.storageKey},0))`,
          );
          const rows = await tx.execute(
            sql`select * from blob_erasure_job where storage_key=${job.storageKey} and sha256=${job.sha256} and storage_key=${job.jobId} and lease_token=${job.leaseToken} and lease_until>${time} and not completed for update`,
          );
          if (!rows.rows.length) return false;
          const refs = await tx.execute(
            sql`select 1 from source_attachment_identity a where a.storage_key=${job.storageKey} and not exists(select 1 from source_redaction r where r.organization_id=a.organization_id and r.source_id=a.source_id) limit 1`,
          );
          if (refs.rows.length) {
            await tx.execute(
              sql`update blob_erasure_job set lease_token=null,lease_until=null,retry_after=${new Date(time.getTime() + 60000)},updated_at=${time} where storage_key=${job.storageKey}`,
            );
            return false;
          }
          let status = "erased";
          try {
            await erase(job.storageKey, job.sha256);
          } catch {
            status = "failed";
          }
          await tx.execute(
            sql`insert into blob_erasure_attempt(id,storage_key,status,occurred_at) values (${randomUUID()},${job.storageKey},${status},${time})`,
          );
          await tx.execute(
            sql`update blob_erasure_job set completed=${status === "erased"},lease_token=null,lease_until=null,retry_after=${status === "erased" ? null : new Date(time.getTime() + 60000)},updated_at=${time} where storage_key=${job.storageKey}`,
          );
          return status === "erased";
        });
      } catch {
        throw new Error("Retention storage unavailable");
      }
    },
  };
}
