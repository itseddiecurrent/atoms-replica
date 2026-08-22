import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";

import { createDatabaseClient } from "../client.js";
import { getMigrationEnv } from "../env.js";

const env = getMigrationEnv();
// Migrations use a dedicated/session-capable connection. On IPv4 platforms,
// DATABASE_URL_DIRECT points to Supavisor session mode (port 5432). Application
// traffic continues to use transaction mode through DATABASE_URL.
const client = createDatabaseClient(env.DATABASE_URL_DIRECT);

try {
  await migrate(client.db, { migrationsFolder: resolve(import.meta.dirname, "../../drizzle") });
  console.info("Database migrations completed.");
} finally {
  await client.close();
}
