import { config } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

config({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

const dataEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .startsWith("postgresql://")
    .refine((value) => new URL(value).hostname.endsWith(".pooler.supabase.com"), {
      message:
        "DATABASE_URL must use the Supabase Shared Pooler host (*.pooler.supabase.com), not the IPv6 Direct DB host."
    }),
  DATABASE_URL_DIRECT: z.string().startsWith("postgresql://"),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1)
});

const migrationEnvSchema = z.object({
  DATABASE_URL_DIRECT: z.string().startsWith("postgresql://")
});

export function getDataEnv() {
  return dataEnvSchema.parse(process.env);
}

export function getMigrationEnv() {
  return migrationEnvSchema.parse(process.env);
}
