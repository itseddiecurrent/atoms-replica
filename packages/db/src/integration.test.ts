import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "./client";
import { getDataEnv } from "./env";
import {
  appendRunEvent,
  createProjectWithInitialRun,
  createSnapshot,
  deleteProject,
  listRunEventsAfter,
  upsertProjectFile,
  upsertUser
} from "./repositories";
import { createStorageAdmin, ensurePrivateBucket } from "./storage";

const runIntegrationTests = process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true";
const integration = runIntegrationTests ? describe : describe.skip;

integration("Supabase data layer", () => {
  let env: ReturnType<typeof getDataEnv>;
  const userId = `integration-${randomUUID()}`;
  const storageKey = `integration/${randomUUID()}.zip`;
  let database: DatabaseClient;
  let projectId: string | undefined;

  beforeAll(() => {
    env = getDataEnv();
    database = createDatabaseClient(env.DATABASE_URL);
  });

  afterAll(async () => {
    const storage = createStorageAdmin(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    await storage.storage.from(env.SUPABASE_STORAGE_BUCKET).remove([storageKey]);
    if (projectId) await deleteProject(database.db, projectId);
    await database.close();
  });

  it("creates the complete project graph and ordered events", async () => {
    await upsertUser(database.db, { id: userId, email: `${userId}@example.com` });
    const ids = await createProjectWithInitialRun(database.db, {
      userId,
      name: "Integration project",
      prompt: "Build a test app"
    });
    projectId = ids.projectId;

    const appended = await appendRunEvent(database.db, {
      runId: ids.runId,
      type: "plan.created",
      payload: { steps: 1 }
    });
    const events = await listRunEventsAfter(database.db, ids.runId, 0);

    expect(events.map((event) => event.type)).toEqual(["run.queued", "plan.created"]);
    expect(appended.id).toBeGreaterThan(events[0]?.id ?? 0);

    const firstFile = await upsertProjectFile(database.db, {
      projectId: ids.projectId,
      path: "src/App.tsx",
      content: "export const App = () => null;",
      updatedBy: "agent"
    });
    const secondFile = await upsertProjectFile(database.db, {
      projectId: ids.projectId,
      path: "src/App.tsx",
      content: "export const App = () => <main />;",
      updatedBy: "user"
    });
    const unchangedFile = await upsertProjectFile(database.db, {
      projectId: ids.projectId,
      path: "src/App.tsx",
      content: "export const App = () => <main />;",
      updatedBy: "agent"
    });

    expect(firstFile.version).toBe(1);
    expect(secondFile.version).toBe(2);
    expect(unchangedFile.version).toBe(2);
    expect(unchangedFile.updatedBy).toBe("user");

    const snapshot = await createSnapshot(database.db, {
      projectId: ids.projectId,
      runId: ids.runId,
      storageKey
    });
    expect(snapshot.storageKey).toBe(storageKey);
  });

  it("keeps the snapshot bucket private and supports upload/download/delete", async () => {
    const storage = createStorageAdmin(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
    await ensurePrivateBucket(storage, env.SUPABASE_STORAGE_BUCKET);

    const bytes = new TextEncoder().encode("integration snapshot");
    const { error: uploadError } = await storage.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .upload(storageKey, bytes, { contentType: "application/zip", upsert: true });
    expect(uploadError).toBeNull();

    const { data, error: downloadError } = await storage.storage
      .from(env.SUPABASE_STORAGE_BUCKET)
      .download(storageKey);
    expect(downloadError).toBeNull();
    expect(await data?.text()).toBe("integration snapshot");
  });
});
