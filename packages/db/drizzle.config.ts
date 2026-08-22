import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../../.env"), quiet: true });

const databaseUrl = process.env.DATABASE_URL_DIRECT;

if (!databaseUrl) {
  throw new Error("DATABASE_URL_DIRECT is required to run Drizzle migrations.");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: databaseUrl
  },
  strict: true,
  verbose: true
});
