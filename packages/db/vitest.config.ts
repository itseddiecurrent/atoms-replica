import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    testTimeout: process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true" ? 30_000 : 5_000,
    hookTimeout: process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true" ? 30_000 : 5_000
  }
});
