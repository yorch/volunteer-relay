import { createHash } from "node:crypto";
import { type PrivateBlobStore, withTrackedBlobWrites } from "@relay/blob";
import { parseEnvironment } from "@relay/config";
import type {
  AuthorizationService,
  Result,
  SourceEnvelope,
  TenantContext,
} from "@relay/contracts";
import {
  createProcessingRepository,
  createSourceStore,
  type Database,
  pruneUnreferencedBlob,
  sql,
} from "@relay/db";
import { createSourceRepository } from "@relay/domain/core";
import { createPhotoTransform } from "@relay/intake";
import sharp from "sharp";
// The provider-free rules adapter and the validating extraction service are
// imported from source, as the demo seed does for its fixture module, so the
// web package needs no new workspace dependency for a demo-only path.
import {
  createDeterministicProvider,
  DETERMINISTIC_MODEL_VERSION,
  DETERMINISTIC_PROMPT_VERSION,
} from "../../../../packages/ai/src/deterministic.ts";
import { createExtractionService } from "../../../../packages/ai/src/service.ts";
import {
  type DemoReplaySample,
  demoReplayOptions,
  findDemoReplaySample,
} from "./demo-replay-samples.ts";
import {
  type ProductProcessing,
  productFailure,
  readProductJson,
} from "./http.ts";

/** Channel identity that marks every replayed source's provenance. */
export const DEMO_REPLAY_CHANNEL_IDENTITY = "demo-replay";

/**
 * Replay is available only when validated configuration says demo mode is on
 * outside production. Configuration validation already refuses
 * DEMO_MODE=true in production; this check fails closed on any parse error.
 */
export function demoReplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.DEMO_MODE !== "true" || env.NODE_ENV === "production") return false;
  try {
    const parsed = parseEnvironment(env);
    return parsed.DEMO_MODE === "true" && parsed.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

/** Deterministic, replay-prefixed identity for one member's sample replay. */
export function demoReplayIdentity(
  organizationId: string,
  membershipId: string,
  sampleId: string,
  idempotencyKey: string,
): { sourceId: string; idempotencyKey: string } {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "demo-replay",
        organizationId,
        membershipId,
        sampleId,
        idempotencyKey,
      ]),
    )
    .digest("hex");
  return { sourceId: `replay:${digest}`, idempotencyKey: `replay:${digest}` };
}

/** Exactly `{ sampleId, idempotencyKey }`; any other field is refused. */
export function parseDemoReplayBody(
  body: unknown,
): { sampleId: string; idempotencyKey: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "idempotencyKey" ||
    keys[1] !== "sampleId"
  )
    return null;
  const { sampleId, idempotencyKey } = record;
  if (
    typeof sampleId !== "string" ||
    !sampleId ||
    sampleId.length > 100 ||
    typeof idempotencyKey !== "string" ||
    !idempotencyKey ||
    idempotencyKey.length > 200
  )
    return null;
  return { sampleId, idempotencyKey };
}

export type DemoReplayProposalStatus =
  | "review"
  | "accepted"
  | "rejected"
  | "queued";

export interface DemoReplayResult {
  sampleId: string;
  sourceId: string;
  revision: number;
  proposal: DemoReplayProposalStatus;
}

export interface DemoReplayDependencies {
  db: Database;
  authorization: AuthorizationService;
  processing: Pick<ProductProcessing, "getSource">;
  store: PrivateBlobStore;
  timezone?: ((organizationId: string) => Promise<string>) | undefined;
  transactional?:
    | ((tx: Database) => {
        authorization?: AuthorizationService;
        processing?: Pick<ProductProcessing, "getSource">;
        timezone?: (organizationId: string) => Promise<string>;
      })
    | undefined;
  /** Test seam; production reads the process environment. */
  environment?: Record<string, string | undefined> | undefined;
}

const photoTransform = createPhotoTransform(sharp);

async function renderSamplePhoto(sample: DemoReplaySample) {
  if (!sample.photo) return null;
  const raw = await sharp(Buffer.from(sample.photo.svg)).png().toBuffer();
  // Same normalization as an uploaded photo: decoded, re-encoded, no metadata.
  const pixels = await photoTransform(raw);
  const sha256 = createHash("sha256").update(pixels).digest("hex");
  return { pixels, sha256, storageKey: `${sha256.slice(0, 2)}/${sha256}` };
}

/**
 * Demo stand-in for one worker cycle on a single replayed source: lease that
 * source's own processing work, run the provider-free rules adapter through
 * the validating extraction service and persist the proposal exactly as the
 * worker does. Never touches another source or tenant, and never calls a
 * model, Telegram or SMTP.
 */
async function draftReplayProposal(
  db: Database,
  context: TenantContext,
  sourceId: string,
): Promise<void> {
  const leased = await db.execute(
    sql`with leased as (update processing_work w set attempts=w.attempts+1,lease_token=gen_random_uuid()::text,lease_until=now()+interval '5 minutes',failed=false where w.organization_id=${context.organizationId} and w.source_id=${sourceId} and w.attempts<3 and (w.lease_until is null or w.lease_until<=now()) and (w.retry_after is null or w.retry_after<=now()) and not exists (select 1 from source_redaction z where z.organization_id=w.organization_id and z.source_id=w.source_id) and not exists (select 1 from source_revision n where n.organization_id=w.organization_id and n.source_id=w.source_id and n.revision>w.source_revision) returning w.*) select s.envelope,w.lease_token,p.policy_version from leased w join source_revision s on (s.organization_id,s.source_id,s.revision)=(w.organization_id,w.source_id,w.source_revision) join processing_policy_snapshot p on (p.organization_id,p.source_id,p.source_revision,p.generation)=(w.organization_id,w.source_id,w.source_revision,w.generation)`,
  );
  const row = leased.rows[0];
  if (!row) return;
  const source = row.envelope as SourceEnvelope;
  const leaseToken = row.lease_token as string;
  const processing = createProcessingRepository(db);
  const worker: TenantContext = {
    organizationId: context.organizationId,
    actor: { kind: "system", service: "worker" },
    correlationId: context.correlationId,
  };
  try {
    const extraction = createExtractionService({
      provider: createDeterministicProvider(),
      maxAttempts: 1,
    });
    const proposal = await extraction.extract(worker, source, {
      model: DETERMINISTIC_MODEL_VERSION,
      prompt: DETERMINISTIC_PROMPT_VERSION,
      policy: row.policy_version as string,
    });
    if (!proposal.ok) {
      await processing.markFailure(source, leaseToken);
      return;
    }
    const saved = await processing.persistProposal(
      worker,
      source,
      proposal.value,
      leaseToken,
    );
    if (!saved.ok) {
      await processing.markFailure(source, leaseToken);
      return;
    }
    await processing.applyValidatedPolicy(source);
  } catch {
    // The source stays queued; nothing about its content is logged.
    await processing.markFailure(source, leaseToken).catch(() => undefined);
  }
}

async function proposalStatus(
  db: Database,
  organizationId: string,
  sourceId: string,
): Promise<DemoReplayProposalStatus> {
  const rows = await db.execute(
    sql`select status from extraction_run where organization_id=${organizationId} and source_id=${sourceId} order by generation desc,created_at desc limit 1`,
  );
  const status = rows.rows[0]?.status;
  return status === "review" || status === "accepted" || status === "rejected"
    ? status
    : "queued";
}

async function staffActor(
  authorization: AuthorizationService,
  context: TenantContext,
): Promise<Result<void>> {
  if (context.actor.kind !== "user")
    return productFailure("FORBIDDEN", context.correlationId);
  const submit = await authorization.require(context, "source:submit");
  if (!submit.ok) return submit;
  const review = await authorization.require(context, "review:write");
  if (!review.ok) return review;
  return { ok: true, value: undefined };
}

/**
 * `GET demo-replay` is a capability probe: `{ enabled: false }` unless demo
 * mode is on and the member may replay. `POST demo-replay` with
 * `{ sampleId, idempotencyKey }` injects one catalog sample through normal
 * intake. Outside demo mode the POST is NOT_FOUND.
 */
export async function handleDemoReplay(
  context: TenantContext,
  request: Request,
  deps: DemoReplayDependencies,
): Promise<Result<unknown>> {
  const denied = (code: Parameters<typeof productFailure>[0]) =>
    productFailure(code, context.correlationId);
  const enabled = demoReplayEnabled(deps.environment ?? process.env);
  if (request.method === "GET") {
    if (!enabled) return { ok: true, value: { enabled: false } };
    const allowed = await staffActor(deps.authorization, context);
    if (!allowed.ok)
      return allowed.error.code === "FORBIDDEN" ||
        allowed.error.code === "NOT_FOUND"
        ? { ok: true, value: { enabled: false } }
        : allowed;
    return { ok: true, value: { enabled: true, samples: demoReplayOptions() } };
  }
  if (!enabled || request.method !== "POST") return denied("NOT_FOUND");
  const allowed = await staffActor(deps.authorization, context);
  if (!allowed.ok) return allowed;
  if (context.actor.kind !== "user") return denied("FORBIDDEN");
  const actor = context.actor;
  let body: ReturnType<typeof parseDemoReplayBody>;
  try {
    body = parseDemoReplayBody(await readProductJson(request));
  } catch {
    return denied("VALIDATION");
  }
  if (!body) return denied("VALIDATION");
  const sample = findDemoReplaySample(body.sampleId);
  if (!sample) return denied("VALIDATION");
  const identity = demoReplayIdentity(
    context.organizationId,
    actor.membershipId,
    sample.id,
    body.idempotencyKey,
  );
  const sourceId = identity.sourceId;
  let photo: Awaited<ReturnType<typeof renderSamplePhoto>>;
  try {
    photo = await renderSamplePhoto(sample);
  } catch {
    return denied("DEPENDENCY_UNAVAILABLE");
  }
  const scoped = (tx: Database) => {
    const built = deps.transactional?.(tx) ?? {};
    return {
      authorization: built.authorization ?? deps.authorization,
      processing: built.processing ?? deps.processing,
      timezone:
        built.timezone ??
        (async (organizationId: string) =>
          (await deps.timezone?.(organizationId)) ?? "UTC"),
    };
  };
  const accept = (
    note?: (blob: { storageKey: string; sha256: string }) => Promise<void>,
  ) =>
    deps.db.transaction(async (tx) => {
      const services = scoped(tx as unknown as Database);
      if (photo)
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`blob:${photo.storageKey}`},0))`,
        );
      const tombstone = await tx.execute(
        sql`select 1 from source_redaction where organization_id=${context.organizationId} and source_id=${sourceId}`,
      );
      if (tombstone.rows.length) return denied("NOT_FOUND");
      const repository = createSourceRepository({
        authorization: services.authorization,
        store: createSourceStore(tx as unknown as Database),
      });
      let attachment: SourceEnvelope["attachments"][number] | null = null;
      if (photo && note) {
        await note({ storageKey: photo.storageKey, sha256: photo.sha256 });
        const blob = await deps.store.put(photo.pixels);
        attachment = {
          ...blob,
          id: `photo:${blob.sha256}`,
          organizationId: context.organizationId,
        };
      }
      const old = await services.processing.getSource(context, sourceId);
      if (old.ok) {
        if (
          old.value.text !== sample.text ||
          old.value.attachments[0]?.sha256 !== attachment?.sha256
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
        channelIdentity: DEMO_REPLAY_CHANNEL_IDENTITY,
        externalMessageId: sourceId,
        idempotencyKey: identity.idempotencyKey,
        author: {
          externalIdentity: actor.userId,
          membershipId: actor.membershipId,
        },
        occurredAt: null,
        receivedAt: new Date().toISOString(),
        timezone: await services.timezone(context.organizationId),
        text: sample.text,
        attachments: attachment ? [attachment] : [],
        replyToSourceId: null,
        replacesRevision: null,
        original: { mediaType: "text/plain", payload: sample.text },
      });
    });
  const accepted = photo
    ? await withTrackedBlobWrites(
        deps.store,
        (note) => accept(note),
        (blob, done) =>
          pruneUnreferencedBlob(
            deps.db,
            blob,
            (key, sha) => deps.store.erase(key, sha),
            done,
          ),
      )
    : await accept();
  if (!accepted.ok) return accepted;
  // Runs after the intake transaction committed; a failure leaves the source
  // queued like any other unprocessed source.
  try {
    await draftReplayProposal(deps.db, context, sourceId);
  } catch {
    // Queued, not lost: the source and its outbox event are already durable.
  }
  const value: DemoReplayResult = {
    sampleId: sample.id,
    sourceId: accepted.value.sourceId,
    revision: accepted.value.revision,
    proposal: await proposalStatus(deps.db, context.organizationId, sourceId),
  };
  return { ok: true, value };
}
