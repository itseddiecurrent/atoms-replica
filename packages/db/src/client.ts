import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseClient {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  const sql = postgres(connectionString, {
    max: 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10
  });

  return {
    db: drizzle(sql, { schema }),
    close: () => sql.end()
  };
}
