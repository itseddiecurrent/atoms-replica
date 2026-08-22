import { describe, expect, it } from "vitest";

import { parseServerEnv, parseWorkerEnv } from "./env";

const browserEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_FIREBASE_API_KEY: "firebase-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "example",
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "example.firebasestorage.app",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "123",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:123:web:abc"
};

describe("environment schemas", () => {
  it("accepts valid server configuration", () => {
    expect(
      parseServerEnv({
        ...browserEnv,
        SESSION_COOKIE_NAME: "session",
        APP_ENCRYPTION_KEY: "a".repeat(64),
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
        SUPABASE_STORAGE_BUCKET: "project-snapshots",
        DATABASE_URL: "postgresql://user:password@localhost:5432/app",
        FIREBASE_ADMIN_PROJECT_ID: "example",
        FIREBASE_ADMIN_CLIENT_EMAIL: "firebase@example.iam.gserviceaccount.com",
        FIREBASE_ADMIN_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey"
      })
    ).toMatchObject({ SESSION_COOKIE_NAME: "session" });
  });

  it("rejects an invalid encryption key", () => {
    expect(() =>
      parseServerEnv({
        ...browserEnv,
        SESSION_COOKIE_NAME: "session",
        APP_ENCRYPTION_KEY: "short",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
        SUPABASE_STORAGE_BUCKET: "project-snapshots",
        DATABASE_URL: "postgresql://user:password@localhost:5432/app",
        FIREBASE_ADMIN_PROJECT_ID: "example",
        FIREBASE_ADMIN_CLIENT_EMAIL: "firebase@example.iam.gserviceaccount.com",
        FIREBASE_ADMIN_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey"
      })
    ).toThrow();
  });

  it("strips Worker-only OpenAI, E2B, and Supabase credentials from Web configuration", () => {
    const parsed = parseServerEnv({
      ...browserEnv,
      SESSION_COOKIE_NAME: "session",
      APP_ENCRYPTION_KEY: "a".repeat(64),
      DATABASE_URL: "postgresql://user:password@localhost:5432/app",
      FIREBASE_ADMIN_PROJECT_ID: "example",
      FIREBASE_ADMIN_CLIENT_EMAIL: "firebase@example.iam.gserviceaccount.com",
      FIREBASE_ADMIN_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey",
      OPENAI_API_KEY: "must-not-be-consumed",
      E2B_API_KEY: "must-not-be-consumed",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-be-consumed"
    });
    expect(parsed).not.toHaveProperty("OPENAI_API_KEY");
    expect(parsed).not.toHaveProperty("E2B_API_KEY");
    expect(parsed).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("accepts an empty optional E2B template id", () => {
    expect(
      parseWorkerEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        OPENAI_API_KEY: "openai-key",
        OPENAI_MODEL: "model",
        OPENAI_MAX_OUTPUT_TOKENS: "12000",
        DATABASE_URL: "postgresql://user:password@localhost:5432/app",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
        SUPABASE_STORAGE_BUCKET: "project-snapshots",
        E2B_API_KEY: "e2b-key",
        E2B_TEMPLATE_ID: "",
        E2B_SANDBOX_TIMEOUT_SECONDS: "900",
        E2B_PREVIEW_PORT: "5173",
        WORKER_CONCURRENCY: "1",
        WORKER_DISABLED: "false",
        WORKER_POLL_INTERVAL_MS: "1000",
        RUN_HEARTBEAT_INTERVAL_MS: "5000",
        RUN_STALE_AFTER_SECONDS: "30",
        MAX_AGENT_TURNS: "20",
        MAX_AGENT_TOOL_CALLS: "60",
        MAX_AGENT_REPAIR_ATTEMPTS: "2"
      }).E2B_TEMPLATE_ID
    ).toBe("");
  });
});
