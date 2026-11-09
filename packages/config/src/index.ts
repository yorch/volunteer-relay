import { z } from "zod";
export const environmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    // The default is a development convenience; parseEnvironment refuses to
    // apply it in production.
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
    // Telegram accepts at most 256 characters; production also requires at
    // least 32 (see superRefine).
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).max(256).optional(),
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
    /**
     * Frozen filesystem volume kept readable (and erasable) during a cutover to
     * S3. Remove it, and delete the volume, once verification passes.
     */
    BLOB_FALLBACK_ROOT: z.string().min(1).optional(),
    ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10485760),
    /**
     * Signs the retention/redaction ledger. Optional: without it, ledger
     * export and redaction answer DEPENDENCY_UNAVAILABLE.
     */
    RETENTION_LEDGER_KEY: z.string().min(32).optional(),
    /**
     * Platform operator allowlist: comma-separated `userId:email` entries.
     * Absent or empty disables the operator console. The user id is immutable,
     * the email is an independent check on configuration mistakes; an address
     * alone is not ownership of an account. Parsed by @relay/contracts at
     * composition time; mirrored here so a malformed list fails at boot.
     */
    OPERATOR_ACCOUNTS: z
      .string()
      .max(4096)
      .optional()
      .superRefine((value, ctx) => {
        const entries = (value ?? "")
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        if (entries.length > 20)
          ctx.addIssue({
            code: "custom",
            message: "At most 20 operator accounts are configured",
          });
        const seen = new Set<string>();
        const emails = new Set<string>();
        for (const entry of entries) {
          const separator = entry.indexOf(":");
          const userId = separator > 0 ? entry.slice(0, separator).trim() : "";
          const email =
            separator > 0
              ? entry
                  .slice(separator + 1)
                  .trim()
                  .toLowerCase()
              : "";
          if (
            !/^[A-Za-z0-9_-]{1,128}$/.test(userId) ||
            !z.email().safeParse(email).success
          )
            ctx.addIssue({
              code: "custom",
              message: "Operator entries must be userId:email",
            });
          else if (email.endsWith(".invalid"))
            ctx.addIssue({
              code: "custom",
              message: "A reserved demonstration domain cannot be an operator",
            });
          else if (seen.has(userId))
            ctx.addIssue({
              code: "custom",
              message: "Operator accounts must be unique by user id",
            });
          else if (emails.has(email))
            ctx.addIssue({
              code: "custom",
              message: "Operator accounts must be unique by address",
            });
          seen.add(userId);
          emails.add(email);
        }
      }),
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
    if (
      env.NODE_ENV === "production" &&
      env.TELEGRAM_WEBHOOK_SECRET !== undefined &&
      env.TELEGRAM_WEBHOOK_SECRET.length < 32
    )
      ctx.addIssue({
        code: "custom",
        path: ["TELEGRAM_WEBHOOK_SECRET"],
        message:
          "Production requires a TELEGRAM_WEBHOOK_SECRET of at least 32 characters",
      });
    if (env.BLOB_FALLBACK_ROOT !== undefined) {
      if (env.BLOB_STORE !== "s3")
        ctx.addIssue({
          code: "custom",
          message:
            "BLOB_FALLBACK_ROOT is only valid while BLOB_STORE=s3 (a cutover window)",
        });
      if (!env.BLOB_FALLBACK_ROOT.startsWith("/"))
        ctx.addIssue({
          code: "custom",
          message: "BLOB_FALLBACK_ROOT must be an absolute path",
        });
    }
    // A demonstration deployment must not carry a live operator console: the
    // demo credentials are public, so an allowlist there would be a shared
    // root account.
    if (
      env.DEMO_MODE === "true" &&
      (env.OPERATOR_ACCOUNTS ?? "").trim().length > 0
    )
      ctx.addIssue({
        code: "custom",
        path: ["OPERATOR_ACCOUNTS"],
        message: "OPERATOR_ACCOUNTS is refused while DEMO_MODE is enabled",
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
export function parseEnvironment(
  env: Record<string, string | undefined>,
): Environment {
  const parsed = environmentSchema.safeParse(env);
  const issues = parsed.success ? [] : [...parsed.error.issues];
  // The schema cannot tell a supplied DATABASE_URL from its development
  // default, so production presence is checked on the raw input.
  if (env.NODE_ENV === "production" && !env.DATABASE_URL)
    issues.push({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "Production requires DATABASE_URL",
      input: env.DATABASE_URL,
    });
  if (issues.length > 0 || !parsed.success) throw new z.ZodError(issues);
  return parsed.data;
}
