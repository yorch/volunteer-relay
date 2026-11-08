import { z } from "zod";
export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    DATABASE_URL: z
      .url()
      .default("postgres://relay:relay@localhost:5432/relay"),
    APP_URL: z.url().default("http://localhost:3000"),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    ATTACHMENT_ROOT: z.string().default("/data/attachments"),
    DEMO_MODE: z.enum(["true", "false"]).default("false"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    OPENAI_MODEL: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_INPUT_MICROUSD_PER_MILLION: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional(),
    OPENAI_OUTPUT_MICROUSD_PER_MILLION: z.coerce
      .number()
      .int()
      .nonnegative()
      .optional(),
    OPENAI_INPUT_TOKEN_LIMIT: z.coerce.number().int().positive().optional(),
    OPENAI_OUTPUT_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .max(16000)
      .default(6000),
    OPENAI_MONTHLY_BUDGET_CENTS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(0),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    TELEGRAM_TRANSPORT: z
      .enum(["replay", "polling", "webhook"])
      .default("replay"),
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_TLS: z.enum(["true", "false"]).default("false"),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.email().default("relay@example.invalid"),
    ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
  })
  .superRefine((env, ctx) => {
    if (
      env.NODE_ENV === "production" &&
      (!env.BETTER_AUTH_SECRET || env.DEMO_MODE === "true")
    )
      ctx.addIssue({
        code: "custom",
        message: "Production requires an auth secret and disabled demo mode",
      });
  });
export const parseEnvironment = (env: Record<string, string | undefined>) =>
  environmentSchema.parse(env);
