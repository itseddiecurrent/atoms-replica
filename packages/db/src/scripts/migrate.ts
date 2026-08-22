import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";

import { createDatabaseClient } from "../client.js";
import { getMigrationEnv } from "../env.js";

const env = getMigrationEnv();
// Railway supports the Direct DB endpoint used for schema changes. Application
// traffic continues to use the transaction pooler through DATABASE_URL.
const client = createDatabaseClient(env.DATABASE_URL_DIRECT);

try {
  await migrate(client.db, { migrationsFolder: resolve(import.meta.dirname, "../../drizzle") });
  console.info("Database migrations completed.");
} finally {
  await client.close();
}
