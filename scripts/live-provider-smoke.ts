import { randomUUID } from "node:crypto";
import {
  createExtractionService,
  createOpenAIProvider,
  OPENAI_PROMPT_VERSION,
} from "../packages/ai/src/index.ts";
import { parseEnvironment } from "../packages/config/src/index.ts";
import type { SourceEnvelope } from "../packages/contracts/src/index.ts";
import {
  createDatabase,
  createModelBudgetRepository,
  schema,
  sql,
} from "../packages/db/src/index.ts";

async function main() {
  if (process.env.RUN_LIVE_PROVIDER_CHECK !== "true") {
    console.error(
      "Live provider check is opt-in: set RUN_LIVE_PROVIDER_CHECK=true with configured model, pricing and budget.",
    );
    process.exitCode = 1;
    return;
  }
  const env = parseEnvironment(process.env);
  if (
    !env.OPENAI_API_KEY ||
    !env.OPENAI_MODEL ||
    !env.OPENAI_INPUT_TOKEN_LIMIT ||
    !env.OPENAI_IMAGE_INPUT_TOKEN_LIMIT ||
    env.OPENAI_INPUT_MICROUSD_PER_MILLION === undefined ||
    env.OPENAI_OUTPUT_MICROUSD_PER_MILLION === undefined ||
    env.OPENAI_MONTHLY_BUDGET_CENTS <= 0
  )
    throw new Error("Provider configuration incomplete");
  const { db, close } = createDatabase(env.DATABASE_URL),
    budget = createModelBudgetRepository(db);
  const org = "relay-synthetic-live-smoke",
    member = "relay-synthetic-live-member",
    user = "relay-synthetic-live-user";
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(schema.organization)
        .values({ id: org, name: "Fictional provider smoke tenant", slug: org })
        .onConflictDoNothing();
      const check = await tx.execute(
        sql`select 1 from organization where id=${org} and slug=${org} and name='Fictional provider smoke tenant'`,
      );
      if (!check.rows.length) throw new Error("Synthetic namespace conflict");
      await tx
        .insert(schema.user)
        .values({
          id: user,
          name: "Fictional smoke volunteer",
          email: "relay-live-smoke@example.invalid",
        })
        .onConflictDoNothing();
      const userCheck = await tx.execute(
        sql`select 1 from "user" where id=${user} and email='relay-live-smoke@example.invalid' and name='Fictional smoke volunteer'`,
      );
      if (!userCheck.rows.length)
        throw new Error("Synthetic user namespace conflict");
      await tx
        .insert(schema.member)
        .values({
          id: member,
          organizationId: org,
          userId: user,
          role: "volunteer",
        })
        .onConflictDoNothing();
    });
    const cases = [
      {
        label: "english",
        text: "I delivered fictional supply boxes for 60 minutes on 2026-11-01.",
        image: false,
      },
      {
        label: "spanish",
        text: "Se necesitan alimentos con urgencia. Este mensaje es una prueba ficticia.",
        image: false,
      },
      { label: "photo-only", text: "", image: true },
    ];
    for (const test of cases) {
      const id = `synthetic-live-${randomUUID()}`,
        now = new Date(),
        windowStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        ).toISOString(),
        windowEnd = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
        ).toISOString();
      const reserved = await budget.reserveModelBudget({
        organizationId: org,
        requestId: id,
        model: env.OPENAI_MODEL,
        windowStart,
        windowEnd,
        limitMicroUsd: env.OPENAI_MONTHLY_BUDGET_CENTS * 10000,
        inputTokenLimit: env.OPENAI_INPUT_TOKEN_LIMIT,
        outputTokenLimit: env.OPENAI_OUTPUT_TOKEN_LIMIT,
        inputMicroUsdPerMillion: env.OPENAI_INPUT_MICROUSD_PER_MILLION,
        outputMicroUsdPerMillion: env.OPENAI_OUTPUT_MICROUSD_PER_MILLION,
      });
      if (!reserved.ok) throw new Error("Budget reservation refused");
      let sent = false;
      try {
        const source: SourceEnvelope = {
          schemaVersion: 1,
          organizationId: org,
          sourceId: id,
          revision: 1,
          channel: "web",
          channelIdentity: member,
          externalMessageId: id,
          idempotencyKey: id,
          author: { externalIdentity: user, membershipId: member },
          occurredAt: null,
          receivedAt: now.toISOString(),
          timezone: "UTC",
          text: test.text,
          attachments: test.image
            ? [
                {
                  id: "synthetic-color",
                  organizationId: org,
                  storageKey: "synthetic",
                  sha256: (await import("node:crypto"))
                    .createHash("sha256")
                    .update(image)
                    .digest("hex"),
                  mimeType: "image/png",
                  bytes: image.length,
                },
              ]
            : [],
          replyToSourceId: null,
          replacesRevision: null,
          original: { mediaType: "text/plain", payload: test.text },
        };
        const provider = createOpenAIProvider({
          apiKey: env.OPENAI_API_KEY,
          maxInputTokens: env.OPENAI_INPUT_TOKEN_LIMIT,
          imageInputTokenLimit: env.OPENAI_IMAGE_INPUT_TOKEN_LIMIT,
          maxOutputTokens: env.OPENAI_OUTPUT_TOKEN_LIMIT,
          readAttachment: async () => image,
          beforeRequest: async () => {
            const result = await budget.markModelBudgetSent(
              reserved.value.reservationId,
            );
            if (!result.ok) throw new Error("Reservation unavailable");
            sent = true;
          },
          onUsage: async (usage) => {
            const result = await budget.settleModelBudget(
              reserved.value.reservationId,
              usage,
            );
            if (!result.ok) throw new Error("Usage settlement unavailable");
          },
        });
        const result = await createExtractionService({
          provider,
          maxAttempts: 1,
        }).extract(
          {
            organizationId: org,
            actor: { kind: "system", service: "worker" },
            correlationId: id,
          },
          source,
          {
            model: env.OPENAI_MODEL,
            prompt: OPENAI_PROMPT_VERSION,
            policy: "synthetic-review-all",
          },
        );
        if (!result.ok) throw new Error("Extraction failed");
        const items = result.value.items;
        if (
          test.label === "english" &&
          !items.some(
            (item) =>
              item.kind === "contribution" && item.durationMinutes === 60,
          )
        )
          throw new Error("Duration assertion failed");
        if (
          test.label === "spanish" &&
          !items.some(
            (item) => item.kind === "need" && item.urgency === "urgent",
          )
        )
          throw new Error("Urgency assertion failed");
        if (
          test.image &&
          items.some(
            (item) =>
              (item.kind === "contribution" &&
                (item.membershipId !== null ||
                  item.durationMinutes !== null)) ||
              (item.kind === "activity" &&
                (item.localDate !== null ||
                  item.beneficiaryReference !== null)),
          )
        )
          throw new Error("Photo inferred unsupported identity or hours");
        console.info(
          JSON.stringify({
            case: test.label,
            status: "passed",
            model: env.OPENAI_MODEL,
            promptVersion: OPENAI_PROMPT_VERSION,
            items: items.length,
          }),
        );
      } finally {
        if (!sent) await budget.cancelModelBudget(reserved.value.reservationId);
      }
    }
  } finally {
    await close();
  }
}
try {
  await main();
} catch {
  console.error(
    "Live provider smoke failed; inspect configuration and safe budget records. No proposal was approved.",
  );
  process.exitCode = 1;
}
