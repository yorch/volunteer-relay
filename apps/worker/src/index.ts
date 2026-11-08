import { createExtractionService, createOpenAIProvider } from "@relay/ai";
import { parseEnvironment } from "@relay/config";
import { createDatabase, createProcessingRepository } from "@relay/db";

if (process.versions.node !== "26.11.1")
  throw new Error("Worker requires Node 26.11.1");
const env = parseEnvironment(process.env);
const { db, close } = createDatabase(env.DATABASE_URL);
const processing = createProcessingRepository(db);
let stopped = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopped = true;
    wake?.();
  });
const extraction =
  env.OPENAI_API_KEY && env.OPENAI_MODEL && env.OPENAI_MONTHLY_BUDGET_CENTS > 0
    ? createExtractionService({
        provider: createOpenAIProvider({ apiKey: env.OPENAI_API_KEY }),
        maxAttempts: 1,
      })
    : null;
console.info(
  JSON.stringify({
    service: "worker",
    status: "ready",
    runtime: process.versions.node,
    extraction: extraction
      ? "configured"
      : "disabled-missing-provider-or-budget",
  }),
);
try {
  while (!stopped) {
    if (extraction) {
      const sources = await processing.pendingSources(5);
      for (const source of sources) {
        if (stopped) break;
        const context = {
          organizationId: source.organizationId,
          actor: { kind: "system" as const, service: "worker" as const },
          correlationId: crypto.randomUUID(),
        };
        try {
          const result = await extraction.extract(context, source, {
            model: env.OPENAI_MODEL ?? "unconfigured",
            prompt: "volunteer-extraction-v1",
            policy: "review-all-v1",
          });
          if (!result.ok) {
            await processing.markFailure(source);
            continue;
          }
          const saved = await processing.persistProposal(
            context,
            source,
            result.value,
          );
          if (!saved.ok) await processing.markFailure(source);
        } catch {
          await processing.markFailure(source);
        }
      }
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
  await close();
  console.info(JSON.stringify({ service: "worker", status: "stopped" }));
}
