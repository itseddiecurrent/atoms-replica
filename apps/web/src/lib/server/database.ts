import { createDatabaseClient } from "@atom-replica/db";

const globalDatabase = globalThis as typeof globalThis & {
  atomDatabase?: ReturnType<typeof createDatabaseClient>;
};

export function getDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  globalDatabase.atomDatabase ??= createDatabaseClient(databaseUrl);
  return globalDatabase.atomDatabase.db;
}
