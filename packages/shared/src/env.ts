import { z } from "zod";

const booleanString = z.enum(["true", "false"]);
const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => Number(value) > 0);

export const browserEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: z.string().min(1),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().min(1)
});

export const serverEnvSchema = browserEnvSchema.extend({
  E2B_PREVIEW_CSP_ORIGIN: z.string().startsWith("https://").optional(),
  SESSION_COOKIE_NAME: z.string().min(1),
  APP_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  FIREBASE_ADMIN_PROJECT_ID: z.string().min(1),
  FIREBASE_ADMIN_CLIENT_EMAIL: z.email(),
  FIREBASE_ADMIN_PRIVATE_KEY: z.string().includes("BEGIN PRIVATE KEY"),
  MAX_DAILY_RUNS_PER_USER: positiveIntegerString.default("20"),
  MAX_MESSAGES_PER_MINUTE_PER_USER: positiveIntegerString.default("6"),
  MAX_CONCURRENT_RUNS_PER_USER: positiveIntegerString.default("1"),
  SENTRY_DSN: z.string().optional()
});

export const workerEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1),
  OPENAI_MAX_OUTPUT_TOKENS: positiveIntegerString,
  DATABASE_URL: z.string().startsWith("postgresql://"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1),
  E2B_API_KEY: z.string().min(1),
  E2B_TEMPLATE_ID: z.string().optional(),
  E2B_SANDBOX_TIMEOUT_SECONDS: positiveIntegerString,
  E2B_PREVIEW_PORT: positiveIntegerString,
  WORKER_CONCURRENCY: positiveIntegerString,
  WORKER_DISABLED: booleanString,
  WORKER_POLL_INTERVAL_MS: positiveIntegerString,
  RUN_HEARTBEAT_INTERVAL_MS: positiveIntegerString,
  RUN_STALE_AFTER_SECONDS: positiveIntegerString,
  MAX_AGENT_TURNS: positiveIntegerString,
  MAX_AGENT_TOOL_CALLS: positiveIntegerString,
  MAX_AGENT_REPAIR_ATTEMPTS: positiveIntegerString,
  MAX_RUN_DURATION_SECONDS: positiveIntegerString.default("600"),
  MAX_COMMAND_DURATION_SECONDS: positiveIntegerString.default("120"),
  SENTRY_DSN: z.string().optional()
});

export type BrowserEnv = z.infer<typeof browserEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function parseBrowserEnv(input: unknown): BrowserEnv {
  return browserEnvSchema.parse(input);
}

export function parseServerEnv(input: unknown): ServerEnv {
  return serverEnvSchema.parse(input);
}

export function parseWorkerEnv(input: unknown): WorkerEnv {
  return workerEnvSchema.parse(input);
}
