import { createExtractionService, createOpenAIProvider } from "@relay/ai";
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
  erasePrivateBlob,
  readPrivateBlob,
  recoverPendingBlobWrites,
} from "@relay/intake";
import {
  createSmtpTransport,
  createTelegramTransport,
} from "@relay/notifications";
import { pollTelegram } from "./telegram.ts";

if (process.versions.node !== "26.11.1")
  throw new Error("Worker requires Node26.11.1");
const env = parseEnvironment(process.env);
const { db, close } = createDatabase(env.DATABASE_URL);
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
const polling = pollTelegram(db, env, () => stopped);
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
        await recoverPendingBlobWrites(env.ATTACHMENT_ROOT, (blob, done) =>
          pruneUnreferencedBlob(
            db,
            blob,
            (key, sha) => erasePrivateBlob(env.ATTACHMENT_ROOT, key, sha),
            done,
          ),
        );
      }
      for (const job of await retention.claimErasureJobs(5)) {
        if (stopped) break;
        await retention.runErasureJob(job, (key, sha) =>
          erasePrivateBlob(env.ATTACHMENT_ROOT, key, sha),
        );
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
          if (stopped) {
            await budgets.cancelModelBudget(reserved.value.reservationId);
            break;
          }
          let sent = false;
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
                  const bytes = await readPrivateBlob(env.ATTACHMENT_ROOT, key);
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
              prompt: "volunteer-extraction-v1",
              policy: policy.policyVersion,
            });
            if (!result.ok) {
              if (!sent)
                await budgets.cancelModelBudget(reserved.value.reservationId);
              await processing.markFailure(source, leaseToken);
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
            if (!sent)
              await budgets.cancelModelBudget(reserved.value.reservationId);
            await processing.markFailure(source, leaseToken);
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
  await close();
  console.info(JSON.stringify({ service: "worker", status: "stopped" }));
}
