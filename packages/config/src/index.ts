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
    OPENAI_IMAGE_INPUT_TOKEN_LIMIT: z.coerce
      .number()
      .int()
      .positive()
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
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_BUCKET: z.string().min(1).max(255).optional(),
    S3_PREFIX: z.string().max(512).optional(),
    S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** Stable per-deployment identifier; a mismatch refuses to write. */
    S3_DEPLOYMENT_ID: z.string().min(1).max(200).optional(),
    S3_ERASURE_MODE: z.enum(["unversioned", "versions"]).default("unversioned"),
    /** Hygiene only; reconciliation never relies on age for delete safety. */
    S3_RECONCILE_MINIMUM_AGE_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(3600000),
    S3_ALLOW_INSECURE: z.enum(["true", "false"]).default("false"),
    BLOB_STORE: z.enum(["filesystem", "s3"]).default("filesystem"),
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
    if (env.BLOB_STORE !== "s3") return;
    if (!env.S3_BUCKET)
      ctx.addIssue({
        code: "custom",
        message: "S3 blob storage requires S3_BUCKET",
      });
    if (!env.S3_DEPLOYMENT_ID)
      ctx.addIssue({
        code: "custom",
        message: "S3 blob storage requires S3_DEPLOYMENT_ID",
      });
    if (Boolean(env.S3_ACCESS_KEY_ID) !== Boolean(env.S3_SECRET_ACCESS_KEY))
      ctx.addIssue({
        code: "custom",
        message: "S3 credentials require both an access key and a secret",
      });
    if (
      env.S3_ENDPOINT?.startsWith("http://") &&
      (env.NODE_ENV === "production" || env.S3_ALLOW_INSECURE !== "true")
    )
      ctx.addIssue({
        code: "custom",
        message:
          "S3_ENDPOINT must use https outside development; set S3_ALLOW_INSECURE=true only for a local endpoint",
      });
  });

/** Parsed environment shared by web, worker and scripts. */
export type Environment = z.infer<typeof environmentSchema>;
export const parseEnvironment = (env: Record<string, string | undefined>) =>
  environmentSchema.parse(env);
