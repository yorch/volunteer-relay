import {
  boundedFailureDetail,
  createExtractionService,
  createOpenAIProvider,
  OPENAI_PROMPT_VERSION,
} from "@relay/ai";
import { createBlobStore } from "@relay/blob";
import { parseEnvironment } from "@relay/config";
import {
  createDatabase,
  createFollowThroughRepository,
  createModelBudgetRepository,
  createProcessingRepository,
  createRetentionRepository,
  pruneUnreferencedBlob,
  sql,
} from "@relay/db";
import {
  createSmtpTransport,
  createTelegramTransport,
} from "@relay/notifications";
import { pollTelegram } from "./telegram.ts";

if (process.versions.node !== "26.11.1")
  throw new Error("Worker requires Node26.11.1");
const env = parseEnvironment(process.env);
const { db, close } = createDatabase(env.DATABASE_URL);
const store = createBlobStore(env);
const processing = createProcessingRepository(db),
  follow = createFollowThroughRepository(db),
  budgets = createModelBudgetRepository(db);
const retention = createRetentionRepository(db);
let nextBlobRecovery = 0;
let stopped = false,
  wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    wake?.();
  });
const smtp = createSmtpTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_TLS === "true",
  from: env.SMTP_FROM,
  appUrl: env.APP_URL,
  ...(env.SMTP_USER
    ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? "" } }
    : {}),
  resolveRecipient: async (org, id) => {
    const r = await db.execute(
      sql`select u.email from member m join "user" u on u.id=m.user_id where m.organization_id=${org} and m.id=${id}`,
    );
    return (r.rows[0]?.email as string | undefined) ?? null;
  },
});
const telegram = env.TELEGRAM_BOT_TOKEN
  ? createTelegramTransport({
      botToken: env.TELEGRAM_BOT_TOKEN,
      appUrl: env.APP_URL,
      resolveChat: async (org, id) => {
        const r = await db.execute(
          sql`select t.identity from telegram_identity t join member m on m.organization_id=t.organization_id and m.id=t.membership_id where t.organization_id=${org} and t.membership_id=${id}`,
        );
        return (r.rows[0]?.identity as string | undefined) ?? null;
      },
    })
  : null;
const configured = Boolean(
  env.OPENAI_API_KEY &&
    env.OPENAI_MODEL &&
    env.OPENAI_MONTHLY_BUDGET_CENTS > 0 &&
    env.OPENAI_INPUT_TOKEN_LIMIT &&
    env.OPENAI_INPUT_MICROUSD_PER_MILLION !== undefined &&
    env.OPENAI_OUTPUT_MICROUSD_PER_MILLION !== undefined,
);
const polling = pollTelegram(db, env, store, () => stopped);
console.info(
  JSON.stringify({
    service: "worker",
    status: "ready",
    runtime: process.versions.node,
    extraction: configured
      ? "configured"
      : "disabled-missing-provider-pricing-or-budget",
  }),
);
try {
  while (!stopped) {
    try {
      if (Date.now() >= nextBlobRecovery) {
        nextBlobRecovery = Date.now() + 60000;
        await store.lifecycle.recover((blob, done) =>
          pruneUnreferencedBlob(
            db,
            blob,
            (key, sha) => store.erase(key, sha),
            done,
          ),
        );
      }
      for (const job of await retention.claimErasureJobs(5)) {
        if (stopped) break;
        await retention.runErasureJob(job, (key, sha) => store.erase(key, sha));
      }
      await follow.processPendingNotifications(50);
      await follow.escalateOverdue(50);
      for (const job of await follow.claimDeliveries(20)) {
        if (stopped) break;
        if (!(await follow.validateDelivery(job))) continue;
        const transport = job.channel === "email" ? smtp : telegram;
        if (!transport) {
          await follow.completeDelivery(job, { status: "failed" });
          continue;
        }
        const result = await transport.deliver(
          {
            organizationId: job.organizationId,
            actor: { kind: "system", service: "worker" },
            correlationId: job.id,
          },
          job,
        );
        await follow.completeDelivery(
          job,
          result.ok ? result.value : { status: "failed" },
        );
      }
      if (configured) {
        for (const {
          source,
          leaseToken,
          policy,
        } of await processing.pendingSources(5)) {
          if (stopped) break;
          const time = new Date(),
            windowStart = new Date(
              Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), 1),
            ).toISOString(),
            windowEnd = new Date(
              Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1),
            ).toISOString();
          const reserved = await budgets.reserveModelBudget({
            organizationId: source.organizationId,
            requestId: leaseToken,
            model: env.OPENAI_MODEL ?? "",
            windowStart,
            windowEnd,
            limitMicroUsd: env.OPENAI_MONTHLY_BUDGET_CENTS * 10000,
            inputTokenLimit: env.OPENAI_INPUT_TOKEN_LIMIT ?? 0,
            outputTokenLimit: env.OPENAI_OUTPUT_TOKEN_LIMIT,
            inputMicroUsdPerMillion: env.OPENAI_INPUT_MICROUSD_PER_MILLION ?? 0,
            outputMicroUsdPerMillion:
              env.OPENAI_OUTPUT_MICROUSD_PER_MILLION ?? 0,
          });
          if (!reserved.ok) {
            await processing.markFailure(source, leaseToken);
            continue;
          }
          let sent = false;
          // One place that decides whether the charge can go back, and reports
          // what actually happened rather than what was intended: a failed
          // cancellation must not be logged as "released".
          const releaseUnsent = async (): Promise<string> => {
            if (sent) return "charged";
            const cancelled = await budgets.cancelModelBudget(
              reserved.value.reservationId,
            );
            if (!cancelled.ok) {
              console.warn(
                JSON.stringify({
                  service: "worker",
                  event: "reservation_release_failed",
                }),
              );
              return "release_failed";
            }
            return "released";
          };
          if (stopped) {
            await releaseUnsent();
            break;
          }
          try {
            const extraction = createExtractionService({
              maxAttempts: 1,
              provider: createOpenAIProvider({
                apiKey: env.OPENAI_API_KEY ?? "",
                maxOutputTokens: env.OPENAI_OUTPUT_TOKEN_LIMIT,
                ...(env.OPENAI_INPUT_TOKEN_LIMIT
                  ? { maxInputTokens: env.OPENAI_INPUT_TOKEN_LIMIT }
                  : {}),
                ...(env.OPENAI_IMAGE_INPUT_TOKEN_LIMIT
                  ? { imageInputTokenLimit: env.OPENAI_IMAGE_INPUT_TOKEN_LIMIT }
                  : {}),
                beforeRequest: async () => {
                  if (stopped) throw new Error("Worker stopping");
                  const marked = await budgets.markModelBudgetSent(
                    reserved.value.reservationId,
                  );
                  if (!marked.ok) throw new Error("Reservation unavailable");
                  sent = true;
                },
                onUsage: async (usage) => {
                  const settled = await budgets.settleModelBudget(
                    reserved.value.reservationId,
                    usage,
                  );
                  if (!settled.ok)
                    throw new Error("Usage settlement unavailable");
                },
                readAttachment: async (key) => {
                  const bytes = await store.read(key);
                  if (!bytes) throw new Error("Image unavailable");
                  return bytes;
                },
              }),
            });
            const context = {
              organizationId: source.organizationId,
              actor: { kind: "system" as const, service: "worker" as const },
              correlationId: crypto.randomUUID(),
            };
            const result = await extraction.extract(context, source, {
              model: env.OPENAI_MODEL ?? "",
              prompt: OPENAI_PROMPT_VERSION,
              policy: policy.policyVersion,
            });
            if (!result.ok) {
              // Only an unsent reservation can be released: nothing was
              // transmitted, so nothing can have been billed. Anything failing
              // after the request starts may have consumed tokens we cannot see
              // — a truncated body, invalid JSON, a schema rejection, a 4xx —
              // and recording it as zero would let repeated failures spend past
              // the cap. Those stay charged, which is the conservative
              // direction; the per-source attempt limit bounds the exposure.
              const reservation = await releaseUnsent();
              await processing.markFailure(source, leaseToken);
              // This failure used to be silent: nothing logged, nothing stored,
              // so a totally broken extraction looked healthy. Keep the record
              // bounded — a code from the closed union, never provider text or
              // source content.
              console.warn(
                JSON.stringify({
                  service: "worker",
                  event: "extraction_failed",
                  // Without a source identifier the detail cannot be tied to a
                  // source when more than one is failing, and the rejected
                  // proposal is not persisted to join against.
                  sourceId: source.sourceId,
                  revision: source.revision,
                  // One correlationId per extraction attempt, so repeated
                  // failures for the same source can be told apart.
                  correlationId: context.correlationId,
                  reason: result.error.code,
                  retryable: result.error.retryable,
                  reservation,
                  // Positions and machine codes only — the service keeps this
                  // detail free of source text, and it is capped before logging.
                  // Without it a rejection says only "VALIDATION" and the
                  // operator has to reconstruct the provider call by hand.
                  detail: boundedFailureDetail(result.error.fields),
                }),
              );
              continue;
            }
            const saved = await processing.persistProposal(
              context,
              source,
              result.value,
              leaseToken,
            );
            if (!saved.ok) {
              await processing.markFailure(source, leaseToken);
              continue;
            }
            await processing.applyValidatedPolicy(source);
            await follow.processPendingNotifications(50);
          } catch {
            // An unexpected exception says nothing about billing, so only an
            // unsent reservation is released; a sent one stays charged.
            await releaseUnsent();
            await processing.markFailure(source, leaseToken);
            // Fixed event only: an unexpected exception can carry provider text,
            // and source content must never reach the logs.
            console.warn(
              JSON.stringify({
                service: "worker",
                event: "extraction_crashed",
              }),
            );
          }
        }
      }
    } catch {
      console.warn(
        JSON.stringify({ service: "worker", event: "cycle-unavailable" }),
      );
    }
    if (!stopped)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
  }
} finally {
  await polling;
  await store.lifecycle.close();
  await close();
  console.info(JSON.stringify({ service: "worker", status: "stopped" }));
}
