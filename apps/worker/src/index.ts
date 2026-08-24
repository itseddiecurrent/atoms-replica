import { config } from "dotenv";
import { resolve } from "node:path";
import {
  appendRunEvent,
  createDatabaseClient,
  createStorageAdmin,
  deleteProjectFile,
  getProjectRuntimeState,
  isRunCancelled,
  listProjectFiles,
  saveProjectPreview,
  saveProjectSandbox,
  upsertProjectFile
} from "@atom-replica/db";
import { createCoder, createPlanner } from "@atom-replica/agent";
import {
  createE2BSandboxSdk,
  E2BSandboxAdapter,
  ensureSandbox,
  SANDBOX_BUILD_COMMAND,
  SANDBOX_INSTALL_COMMAND
} from "@atom-replica/sandbox";
import {
  captureException,
  logProviderCall,
  observeProviderCall,
  readProjectZip,
  shouldIncludeProjectFile
} from "@atom-replica/shared";
import { parseWorkerEnv } from "@atom-replica/shared/env";

import { getWorkerMode, startWorker } from "./runtime.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const mode = getWorkerMode(process.env.WORKER_DISABLED);

if (mode === "disabled") {
  console.info("[worker] Polling is disabled.");
} else {
  const env = parseWorkerEnv(process.env);
  const database = createDatabaseClient(env.DATABASE_URL);
  const storage = createStorageAdmin(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const snapshotBucket = storage.storage.from(env.SUPABASE_STORAGE_BUCKET);
  const planner = createPlanner({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    maxOutputTokens: Number(env.OPENAI_MAX_OUTPUT_TOKENS),
    onProviderCall: (call) =>
      logProviderCall({ provider: "openai", operation: "responses.plan", ...call })
  });
  const workerId = `worker-${process.pid}`;
  const shutdown = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      console.info(`[worker] Received ${signal}; stopping after the current operation.`);
      shutdown.abort();
    });
  }
  console.info(`[worker] Polling every ${env.WORKER_POLL_INTERVAL_MS}ms as ${workerId}.`);

  async function prepareProjectSandbox(projectId: string) {
    const sandbox = new E2BSandboxAdapter({
      sdk: createE2BSandboxSdk(env.E2B_API_KEY),
      templateDir: resolve(import.meta.dirname, "../../../templates/react-vite"),
      ...(env.E2B_TEMPLATE_ID ? { templateId: env.E2B_TEMPLATE_ID } : {}),
      timeoutMs: Number(env.E2B_SANDBOX_TIMEOUT_SECONDS) * 1000,
      commandTimeoutMs: Number(env.MAX_COMMAND_DURATION_SECONDS) * 1_000,
      onProviderCall: (call) => logProviderCall({ provider: "e2b", ...call })
    });
    const state = await getProjectRuntimeState(database.db, projectId);
    if (!state) throw new Error("Project runtime state was not found.");
    const projectFiles = await listProjectFiles(database.db, projectId);
    if (state.project.sandboxId || state.snapshot || projectFiles.length) {
      let snapshotFiles: Array<{ path: string; content: string }> = [];
      if (state.snapshot) {
        const { data, error } = await observeProviderCall(
          { provider: "supabase", operation: "storage.download" },
          () => snapshotBucket.download(state.snapshot!.storageKey)
        );
        if (error) throw error;
        snapshotFiles = readProjectZip(new Uint8Array(await data.arrayBuffer()));
      }
      const restored = await ensureSandbox({
        adapter: sandbox,
        sandboxId: state.project.sandboxId,
        sandboxExpiresAt: state.project.sandboxExpiresAt,
        snapshotFiles,
        projectFiles,
        previewPort: Number(env.E2B_PREVIEW_PORT)
      });
      await saveProjectSandbox(database.db, {
        projectId,
        sandboxId: restored.sandboxId,
        expiresAt: new Date(Date.now() + Number(env.E2B_SANDBOX_TIMEOUT_SECONDS) * 1000)
      });
      if (restored.created && restored.previewUrl)
        await saveProjectPreview(database.db, { projectId, previewUrl: restored.previewUrl });
      return {
        sandbox,
        projectFiles,
        created: restored.created,
        previewUrl: restored.previewUrl ?? state.project.previewUrl ?? undefined
      };
    }
    const sandboxId = await sandbox.create();
    await saveProjectSandbox(database.db, {
      projectId,
      sandboxId,
      expiresAt: new Date(Date.now() + Number(env.E2B_SANDBOX_TIMEOUT_SECONDS) * 1000)
    });
    return { sandbox, projectFiles, created: true, previewUrl: undefined };
  }

  startWorker(database.db, {
    signal: shutdown.signal,
    workerId,
    pollIntervalMs: Number(env.WORKER_POLL_INTERVAL_MS),
    staleAfterMs: Number(env.RUN_STALE_AFTER_SECONDS) * 1000,
    planner,
    snapshotStore: {
      async upload(path, content) {
        await observeProviderCall(
          { provider: "supabase", operation: "storage.upload" },
          async () => {
            const { error } = await snapshotBucket.upload(path, content, {
              contentType: "application/zip",
              upsert: true
            });
            if (error) throw error;
          }
        );
      },
      async remove(paths) {
        await observeProviderCall(
          { provider: "supabase", operation: "storage.remove" },
          async () => {
            const { error } = await snapshotBucket.remove(paths);
            if (error) throw error;
          }
        );
      }
    },
    validationOptions: {
      maxRepairAttempts: Number(env.MAX_AGENT_REPAIR_ATTEMPTS),
      previewPort: Number(env.E2B_PREVIEW_PORT),
      installCommand: SANDBOX_INSTALL_COMMAND,
      buildCommand: SANDBOX_BUILD_COMMAND,
      installTimeoutMs: Number(env.MAX_COMMAND_DURATION_SECONDS) * 1_000,
      buildTimeoutMs: Number(env.MAX_COMMAND_DURATION_SECONDS) * 1_000,
      maxRunDurationMs: Number(env.MAX_RUN_DURATION_SECONDS) * 1_000
    },
    hooks: {
      onError(error, context) {
        void captureException(error, {
          ...(env.SENTRY_DSN ? { dsn: env.SENTRY_DSN } : {}),
          context
        });
      }
    },
    runtimeJobHandler: async (job) => {
      const prepared = await prepareProjectSandbox(job.projectId);
      if (job.type === "sync_file") {
        const payload =
          job.payloadJson && typeof job.payloadJson === "object"
            ? (job.payloadJson as { path?: unknown })
            : {};
        if (typeof payload.path !== "string" || !shouldIncludeProjectFile(payload.path))
          throw new Error("Runtime file path is invalid.");
        const file = prepared.projectFiles.find(({ path }) => path === payload.path);
        if (!file) throw new Error("Runtime file no longer exists.");
        await prepared.sandbox.writeFile(file.path, file.content);
        return {
          operation: "sync_file",
          path: file.path,
          version: file.version,
          previewUrl: prepared.previewUrl ?? null
        };
      }
      if (!prepared.created) {
        await prepared.sandbox.restartDevServer({ port: Number(env.E2B_PREVIEW_PORT) });
      }
      const previewUrl =
        prepared.created && prepared.previewUrl
          ? prepared.previewUrl
          : await prepared.sandbox.getPreviewUrl(Number(env.E2B_PREVIEW_PORT));
      await saveProjectPreview(database.db, { projectId: job.projectId, previewUrl });
      return { operation: "restart_preview", previewUrl };
    },
    coderFactory: async (run) => {
      const prepared = await prepareProjectSandbox(run.projectId);
      const sandbox = prepared.sandbox;
      if (prepared.created && prepared.previewUrl)
        await appendRunEvent(database.db, {
          runId: run.id,
          type: "preview.ready",
          payload: { url: prepared.previewUrl }
        });
      const coder = createCoder(
        {
          apiKey: env.OPENAI_API_KEY,
          model: env.OPENAI_MODEL,
          maxOutputTokens: Number(env.OPENAI_MAX_OUTPUT_TOKENS),
          maxTurns: Number(env.MAX_AGENT_TURNS),
          maxToolCalls: Number(env.MAX_AGENT_TOOL_CALLS),
          maxTotalTokens: Number(env.MAX_AGENT_TOTAL_TOKENS),
          maxDurationMs: Number(env.MAX_RUN_DURATION_SECONDS) * 1_000,
          commandTimeoutMs: Number(env.MAX_COMMAND_DURATION_SECONDS) * 1_000,
          shouldCancel: () => isRunCancelled(database.db, run.id),
          onProviderCall: (call) =>
            logProviderCall({ provider: "openai", operation: "responses.code", ...call }),
          onEvent: async (event) => {
            await appendRunEvent(database.db, { runId: run.id, ...event });
          },
          onFileChanged: async (path, action) => {
            if (action === "deleted") {
              await deleteProjectFile(database.db, { projectId: run.projectId, path });
              return;
            }
            await upsertProjectFile(database.db, {
              projectId: run.projectId,
              path,
              content: await sandbox.readFile(path),
              updatedBy: "agent"
            });
          }
        },
        sandbox
      );
      return { coder, sandbox };
    }
  })
    .catch(async (error) => {
      console.error("[worker] Fatal polling error", error);
      await captureException(error, {
        ...(env.SENTRY_DSN ? { dsn: env.SENTRY_DSN } : {}),
        context: { service: "worker", phase: "polling" }
      });
      process.exitCode = 1;
    })
    .finally(async () => {
      await database.close();
      console.info("[worker] Database connection closed.");
    });
}
