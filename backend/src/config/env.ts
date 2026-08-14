import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_HOST: z.string().min(1, "REDIS_HOST is required"),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),

  GOOGLE_CLIENT_ID: z.string().min(1, "GOOGLE_CLIENT_ID is required"),
  GOOGLE_CLIENT_SECRET: z.string().min(1, "GOOGLE_CLIENT_SECRET is required"),
  GOOGLE_CALLBACK_URL: z.string().url("GOOGLE_CALLBACK_URL must be a valid URL"),

  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),

  FRONTEND_URL: z.string().url().default("http://localhost:5173"),

  // Campaign-creation input bounds for this stage; actual send-rate throttling
  // is enforced later by the BullMQ worker layer, not here.
  MIN_EMAIL_DELAY: z.coerce.number().int().min(0).default(1),
  MAX_EMAILS_PER_HOUR: z.coerce.number().int().positive().default(500),

  // Ethereal (fake SMTP) — see src/services/smtp.service.ts.
  ETHEREAL_HOST: z.string().min(1, "ETHEREAL_HOST is required"),
  ETHEREAL_PORT: z.coerce.number().int().positive().default(587),
  ETHEREAL_USER: z.string().min(1, "ETHEREAL_USER is required"),
  ETHEREAL_PASSWORD: z.string().min(1, "ETHEREAL_PASSWORD is required"),
  // z.coerce.boolean() would treat the literal string "false" as truthy
  // (JS `Boolean("false")` is `true`), so this parses the raw string exactly
  // instead of relying on that coercion.
  ETHEREAL_SECURE: z.preprocess(
    (val) => (typeof val === "string" ? val.toLowerCase() === "true" : val),
    z.boolean().default(false),
  ),

  // How many jobs a single worker PROCESS may handle concurrently — not how
  // many worker processes to run (we run those manually, one per terminal).
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // Retry policy for transient send failures — see src/utils/idempotency.ts
  // for which failures are retried vs treated as permanent.
  EMAIL_JOB_ATTEMPTS: z.coerce.number().int().positive().default(3),
  EMAIL_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(5000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
