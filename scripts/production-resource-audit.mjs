import assert from "node:assert/strict";
import { loadEnvFile } from "node:process";

import {
  createDatabaseClient,
  createStorageAdmin,
  getProductionResourceReferences
} from "../packages/db/dist/index.js";
import { killE2BSandbox, listE2BSandboxes } from "../packages/sandbox/dist/index.js";

try {
  loadEnvFile(".env");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the production resource audit.`);
  return value;
}

async function listStorageKeys(bucket, prefix = "") {
  const keys = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await bucket.list(prefix, {
      limit: 1_000,
      offset,
      sortBy: { column: "name", order: "asc" }
    });
    if (error) throw error;
    for (const entry of data ?? []) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id) keys.push(path);
      else keys.push(...(await listStorageKeys(bucket, path)));
    }
    if ((data?.length ?? 0) < 1_000) break;
    offset += data.length;
  }
  return keys;
}

const staleSeconds = Number(process.env.RUN_STALE_AFTER_SECONDS ?? 30);
const orphanGraceSeconds = Number(process.env.E2E_RESOURCE_ORPHAN_GRACE_SECONDS ?? 120);
const cleanupConfirmed = process.env.E2E_RESOURCE_CLEANUP_CONFIRMED === "true";
assert.ok(staleSeconds > 0 && orphanGraceSeconds > 0, "Audit grace values must be positive.");
const database = createDatabaseClient(required("DATABASE_URL"));

try {
  const references = await getProductionResourceReferences(
    database.db,
    new Date(Date.now() - staleSeconds * 2 * 1_000)
  );
  const storage = createStorageAdmin(
    required("NEXT_PUBLIC_SUPABASE_URL"),
    required("SUPABASE_SERVICE_ROLE_KEY")
  );
  const bucket = storage.storage.from(required("SUPABASE_STORAGE_BUCKET"));
  let [storageKeys, sandboxes] = await Promise.all([
    listStorageKeys(bucket),
    listE2BSandboxes(required("E2B_API_KEY"))
  ]);
  const referencedStorage = new Set(references.snapshotStorageKeys);
  const referencedSandboxes = new Set(references.sandboxIds);
  let orphanStorageKeys = storageKeys.filter((key) => !referencedStorage.has(key));
  const sandboxCutoff = Date.now() - orphanGraceSeconds * 1_000;
  let orphanSandboxIds = sandboxes
    .filter(
      ({ sandboxId, startedAt }) =>
        !referencedSandboxes.has(sandboxId) && startedAt.getTime() < sandboxCutoff
    )
    .map(({ sandboxId }) => sandboxId);

  if (cleanupConfirmed && (orphanStorageKeys.length || orphanSandboxIds.length)) {
    if (orphanStorageKeys.length) {
      const { error } = await bucket.remove(orphanStorageKeys);
      if (error) throw error;
    }
    for (const sandboxId of orphanSandboxIds)
      await killE2BSandbox(sandboxId, required("E2B_API_KEY"));
    [storageKeys, sandboxes] = await Promise.all([
      listStorageKeys(bucket),
      listE2BSandboxes(required("E2B_API_KEY"))
    ]);
    orphanStorageKeys = storageKeys.filter((key) => !referencedStorage.has(key));
    orphanSandboxIds = sandboxes
      .filter(
        ({ sandboxId, startedAt }) =>
          !referencedSandboxes.has(sandboxId) && startedAt.getTime() < sandboxCutoff
      )
      .map(({ sandboxId }) => sandboxId);
  }

  assert.equal(references.staleRuns, 0, "Production contains a stale active Run.");
  assert.equal(references.staleRuntimeJobs, 0, "Production contains a stale Runtime Job.");
  assert.equal(
    references.staleResourceCleanupJobs,
    0,
    "Production contains a stale resource cleanup job."
  );
  assert.equal(
    orphanStorageKeys.length,
    0,
    `Snapshot Storage contains ${orphanStorageKeys.length} unreferenced objects.`
  );
  assert.equal(
    orphanSandboxIds.length,
    0,
    `E2B contains ${orphanSandboxIds.length} old unreferenced Sandboxes.`
  );

  console.info("# Production Resource Hygiene Record");
  console.info("");
  console.info(`- Verified at: ${new Date().toISOString()}`);
  console.info("- Stale Runs: 0");
  console.info("- Stale Runtime Jobs: 0");
  console.info("- Stale resource cleanup jobs: 0");
  console.info(`- Snapshot objects: ${storageKeys.length}; unreferenced: 0`);
  console.info(`- Active E2B Sandboxes: ${sandboxes.length}; old unreferenced: 0`);
  console.info("");
  console.info("No database credential, provider key, Sandbox ID, or Snapshot key is printed.");
} finally {
  await Promise.race([database.close(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}
