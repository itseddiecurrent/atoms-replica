import {
  appendRunEvent,
  beginRunCoding,
  beginRunValidation,
  claimNextRun,
  completeRun,
  completeRuntimeJob,
  createSnapshot,
  createDatabaseClient,
  claimNextRuntimeJob,
  failRun,
  failRuntimeJob,
  finalizeRun,
  getMessageContent,
  getProjectAgentContext,
  heartbeatRun,
  heartbeatRuntimeJob,
  isRunCancelled,
  recordRunUsage,
  recoverStaleRuns,
  recoverStaleRuntimeJobs,
  pruneProjectSnapshots,
  saveProjectPreview,
  saveRunPlan,
  upsertProjectFile,
  type ClaimedRuntimeJob,
  type Database
} from "@atom-replica/db";
import type { CoderInput, ImplementationPlan } from "@atom-replica/agent";
import {
  createProjectZip,
  errorCodes,
  shouldIncludeProjectFile,
  type ErrorCode
} from "@atom-replica/shared";

export type WorkerMode = "disabled" | "polling";

export function getWorkerMode(value: string | undefined): WorkerMode {
  return value === "true" ? "disabled" : "polling";
}

type Planner = {
  createPlan(prompt: string): Promise<ImplementationPlan>;
  consumeMetrics?(): { totalTokens: number; retryCount: number };
};
type Coder = {
  consumeMetrics?(): { totalTokens: number; retryCount: number };
  run(input: CoderInput): Promise<{
    summary: string;
    turns: number;
    toolCalls: number;
    totalTokens: number;
    retryCount?: number;
  }>;
};
type RunSandbox = {
  runCommand(
    command: string,
    options?: { timeoutMs?: number }
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  startDevServer(options?: { port?: number }): Promise<void>;
  getPreviewUrl(port?: number): Promise<string>;
  listFiles(path?: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  kill(): Promise<void>;
};
type RunContext = { coder: Coder; sandbox: RunSandbox };
type CoderFactory = (run: {
  id: string;
  projectId: string;
  workerId: string;
}) => Promise<RunContext>;

type ValidationOptions = {
  maxRepairAttempts?: number;
  previewPort?: number;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
  maxRunDurationMs?: number;
  cancellationPollMs?: number;
};

type SnapshotStore = {
  upload(path: string, content: Uint8Array): Promise<void>;
  remove(paths: string[]): Promise<void>;
};

class RunProcessingError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode
  ) {
    super(message);
  }
}

class RunCancelledError extends RunProcessingError {
  constructor() {
    super("Run cancelled by user.", errorCodes.RUN_CANCELLED);
  }
}

type RuntimeHooks = {
  onError?: (
    error: unknown,
    context: { runId: string; projectId: string; code: ErrorCode }
  ) => void;
};

type RuntimeJobHandler = (
  job: ClaimedRuntimeJob
) => Promise<Record<string, string | number | boolean | null>>;

export async function processNextRuntimeJob(
  db: Database,
  workerId: string,
  handler: RuntimeJobHandler,
  hooks: RuntimeHooks = {},
  heartbeatIntervalMs = 5_000
) {
  const job = await claimNextRuntimeJob(db, workerId);
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void heartbeatRuntimeJob(db, job.id, workerId).catch((error) =>
      hooks.onError?.(error, {
        runId: job.id,
        projectId: job.projectId,
        code: errorCodes.INTERNAL_ERROR
      })
    );
  }, heartbeatIntervalMs);
  try {
    const result = await handler(job);
    await completeRuntimeJob(db, { runtimeJobId: job.id, workerId, result });
  } catch (error) {
    await failRuntimeJob(db, {
      runtimeJobId: job.id,
      workerId,
      message: "Runtime operation failed. Retry the operation."
    });
    hooks.onError?.(error, {
      runId: job.id,
      projectId: job.projectId,
      code: errorCodes.SANDBOX_FAILED
    });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

function commandOutput(result: { stdout: string; stderr: string }) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function validationMessage(command: string, output: string) {
  const detail = output || "The command exited without diagnostic output.";
  return `${command} failed:\n${detail}`;
}

function classifyRunError(error: unknown): { code: ErrorCode; message: string } {
  const message = error instanceof Error ? error.message : "Worker failed.";
  if (error instanceof RunProcessingError) return { code: error.code, message };
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  if (code === "PLAN_INVALID") return { code: errorCodes.PLAN_INVALID, message };
  if (code === "OPENAI_ERROR" || code === "CODER_ERROR" || code === "CODER_INVALID_TOOL")
    return { code: errorCodes.AI_FAILED, message };
  if (code === "CODER_LIMIT") {
    const limit =
      error && typeof error === "object" && "limit" in error
        ? String((error as { limit?: unknown }).limit)
        : "";
    return {
      code: limit === "duration" ? errorCodes.RUN_TIMEOUT : errorCodes.AI_LIMIT,
      message
    };
  }
  if (code === "CODER_CANCELLED") return { code: errorCodes.RUN_CANCELLED, message };
  return { code: errorCodes.INTERNAL_ERROR, message };
}

export async function processNextRun(
  db: Database,
  workerId: string,
  planner?: Planner,
  coder?: Coder,
  coderFactory?: CoderFactory,
  validationOptions: ValidationOptions = {},
  snapshotStore?: SnapshotStore,
  hooks: RuntimeHooks = {}
) {
  const run = await claimNextRun(db, workerId);
  if (!run) return false;
  const claimedRun = run;

  const runStartedAt = Date.now();
  const maxRunDurationMs = validationOptions.maxRunDurationMs ?? 10 * 60 * 1_000;
  let modelTokens = 0;
  let retryCount = 0;
  let sandboxStartedAt: number | undefined;
  let runContext: RunContext | undefined;

  async function checkBoundary() {
    if (await isRunCancelled(db, claimedRun.id)) throw new RunCancelledError();
    if (Date.now() - runStartedAt > maxRunDurationMs)
      throw new RunProcessingError("Run duration limit exceeded.", errorCodes.RUN_TIMEOUT);
  }

  async function runSandboxCommand(command: string, timeoutMs: number) {
    if (!runContext) throw new Error("Sandbox context is unavailable.");
    await checkBoundary();
    let polling = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      const poll = async () => {
        if (!polling) return;
        try {
          if (await isRunCancelled(db, claimedRun.id)) {
            polling = false;
            if (runContext) await runContext.sandbox.kill().catch(() => undefined);
            reject(new RunCancelledError());
            return;
          }
        } catch (error) {
          polling = false;
          reject(error);
          return;
        }
        timer = setTimeout(poll, validationOptions.cancellationPollMs ?? 500);
      };
      timer = setTimeout(poll, validationOptions.cancellationPollMs ?? 500);
    });
    try {
      const result = await Promise.race([
        runContext.sandbox.runCommand(command, { timeoutMs }),
        cancellation
      ]);
      await checkBoundary();
      return result;
    } finally {
      polling = false;
      if (timer) clearTimeout(timer);
    }
  }

  try {
    await checkBoundary();
    await appendRunEvent(db, { runId: run.id, type: "run.planning", payload: {} });
    const prompt = await getMessageContent(db, run.triggerMessageId);
    if (!prompt) throw new Error("Trigger message was not found.");
    const agentContext = await getProjectAgentContext(db, run.projectId);
    const recentContext = agentContext.messages
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n");
    let plan: ImplementationPlan;
    if (planner) {
      try {
        plan = await planner.createPlan(`${recentContext}\nCurrent request: ${prompt}`);
      } finally {
        const metrics = planner.consumeMetrics?.();
        modelTokens += metrics?.totalTokens ?? 0;
        retryCount += metrics?.retryCount ?? 0;
      }
    } else {
      plan = {
        summary: "Prepare the project files and validate a working Preview.",
        assumptions: [],
        steps: [{ id: "step-1", title: "Prepare project files", status: "pending" as const }],
        acceptanceCriteria: []
      };
    }
    await checkBoundary();
    await saveRunPlan(db, run.id, plan);
    await appendRunEvent(db, {
      runId: run.id,
      type: "plan.created",
      payload: { summary: plan.summary, steps: plan.steps.map((step) => step.title) }
    });
    await appendRunEvent(db, {
      runId: run.id,
      type: "step.started",
      payload: { step: "step-1", title: "Prepare project files" }
    });
    await heartbeatRun(db, run.id, workerId);
    await appendRunEvent(db, {
      runId: run.id,
      type: "assistant.delta",
      payload: { text: plan.summary }
    });
    if (coderFactory) {
      sandboxStartedAt = Date.now();
      try {
        runContext = await coderFactory({ id: run.id, projectId: run.projectId, workerId });
      } catch (error) {
        if (await isRunCancelled(db, run.id)) throw new RunCancelledError();
        throw new RunProcessingError(
          error instanceof Error ? error.message : "Sandbox creation failed.",
          errorCodes.SANDBOX_FAILED
        );
      }
    }
    const activeCoder = coder ?? runContext?.coder;
    if (activeCoder) {
      await checkBoundary();
      await beginRunCoding(db, run.id, workerId);
      await appendRunEvent(db, { runId: run.id, type: "run.coding", payload: {} });
      let codingResult;
      try {
        codingResult = await activeCoder.run({
          prompt,
          plan,
          fileTree: agentContext.files.map((file) => file.path),
          recentContext
        });
      } finally {
        const metrics = activeCoder.consumeMetrics?.();
        modelTokens += metrics?.totalTokens ?? codingResult?.totalTokens ?? 0;
        retryCount += metrics?.retryCount ?? codingResult?.retryCount ?? 0;
      }
      await checkBoundary();
      await appendRunEvent(db, {
        runId: run.id,
        type: "assistant.delta",
        payload: { text: codingResult.summary }
      });
      await beginRunValidation(db, run.id, workerId);
      await appendRunEvent(db, { runId: run.id, type: "run.validating", payload: {} });
      if (!runContext) return true;

      const installCommand = "pnpm install --frozen-lockfile=false";
      const installResult = await runSandboxCommand(
        installCommand,
        validationOptions.installTimeoutMs ?? 120_000
      );
      await appendRunEvent(db, {
        runId: run.id,
        type: "command.output",
        payload: { command: installCommand, output: commandOutput(installResult) }
      });
      if (installResult.exitCode !== 0) {
        throw new RunProcessingError(
          validationMessage(installCommand, commandOutput(installResult)),
          errorCodes.BUILD_FAILED
        );
      }

      const buildCommand = "pnpm build";
      const maxRepairAttempts = validationOptions.maxRepairAttempts ?? 2;
      let buildResult = await runSandboxCommand(
        buildCommand,
        validationOptions.buildTimeoutMs ?? 120_000
      );
      await appendRunEvent(db, {
        runId: run.id,
        type: "command.output",
        payload: { command: buildCommand, output: commandOutput(buildResult) }
      });

      for (let attempt = 0; buildResult.exitCode !== 0; attempt += 1) {
        const message = validationMessage(buildCommand, commandOutput(buildResult));
        await appendRunEvent(db, {
          runId: run.id,
          type: "validation.failed",
          payload: { message, attempt }
        });
        if (attempt >= maxRepairAttempts) {
          throw new RunProcessingError(message, errorCodes.BUILD_FAILED);
        }

        retryCount += 1;
        await checkBoundary();
        await beginRunCoding(db, run.id, workerId);
        await appendRunEvent(db, { runId: run.id, type: "run.coding", payload: {} });
        let repairResult;
        try {
          repairResult = await activeCoder.run({
            prompt: `Repair the project so ${buildCommand} succeeds.`,
            plan,
            fileTree: [],
            recentContext: message
          });
        } finally {
          const metrics = activeCoder.consumeMetrics?.();
          modelTokens += metrics?.totalTokens ?? repairResult?.totalTokens ?? 0;
          retryCount += metrics?.retryCount ?? repairResult?.retryCount ?? 0;
        }
        await checkBoundary();
        await beginRunValidation(db, run.id, workerId);
        await appendRunEvent(db, { runId: run.id, type: "run.validating", payload: {} });
        await heartbeatRun(db, run.id, workerId);
        buildResult = await runSandboxCommand(
          buildCommand,
          validationOptions.buildTimeoutMs ?? 120_000
        );
        await appendRunEvent(db, {
          runId: run.id,
          type: "command.output",
          payload: { command: buildCommand, output: commandOutput(buildResult) }
        });
      }

      try {
        await checkBoundary();
        await runContext.sandbox.startDevServer(
          validationOptions.previewPort ? { port: validationOptions.previewPort } : undefined
        );
        const previewUrl = await runContext.sandbox.getPreviewUrl(validationOptions.previewPort);
        await checkBoundary();
        await saveProjectPreview(db, { projectId: run.projectId, previewUrl });
        await appendRunEvent(db, {
          runId: run.id,
          type: "preview.ready",
          payload: { url: previewUrl }
        });
      } catch (error) {
        throw new RunProcessingError(
          error instanceof Error ? error.message : "Preview failed to start.",
          error instanceof RunProcessingError ? error.code : errorCodes.SANDBOX_FAILED
        );
      }

      if (snapshotStore) {
        try {
          const files = [];
          for (const path of await runContext.sandbox.listFiles()) {
            await checkBoundary();
            if (!shouldIncludeProjectFile(path)) continue;
            const content = await runContext.sandbox.readFile(path);
            files.push({ path, content });
            await upsertProjectFile(db, {
              projectId: run.projectId,
              path,
              content,
              updatedBy: "agent"
            });
          }
          const storageKey = `${run.projectId}/${run.id}.zip`;
          await checkBoundary();
          await snapshotStore.upload(storageKey, createProjectZip(files));
          await createSnapshot(db, { projectId: run.projectId, runId: run.id, storageKey });
          const staleKeys = await pruneProjectSnapshots(db, run.projectId, 5);
          if (staleKeys.length) await snapshotStore.remove(staleKeys);
          await finalizeRun(db, {
            runId: run.id,
            projectId: run.projectId,
            workerId,
            summary: codingResult.summary
          });
        } catch (error) {
          throw new RunProcessingError(
            error instanceof Error ? error.message : "Snapshot creation failed.",
            error instanceof RunProcessingError ? error.code : errorCodes.SNAPSHOT_FAILED
          );
        }
      } else {
        await completeRun(db, { runId: run.id, projectId: run.projectId, workerId });
      }
      await appendRunEvent(db, {
        runId: run.id,
        type: "run.completed",
        payload: { summary: codingResult.summary }
      });
      return true;
    }
    await completeRun(db, { runId: run.id, projectId: run.projectId, workerId });
    await appendRunEvent(db, {
      runId: run.id,
      type: "run.completed",
      payload: { summary: "Queue and event streaming are ready." }
    });
  } catch (error) {
    const classified = classifyRunError(error);
    const cancelled =
      classified.code === errorCodes.RUN_CANCELLED || (await isRunCancelled(db, run.id));
    if (cancelled) {
      if (runContext) await runContext.sandbox.kill().catch(() => undefined);
    } else {
      const failed =
        (await failRun(db, {
          runId: run.id,
          projectId: run.projectId,
          workerId,
          code: classified.code,
          message: classified.message
        })) !== false;
      if (failed) {
        await appendRunEvent(db, {
          runId: run.id,
          type: "run.failed",
          payload: classified
        });
      }
      hooks.onError?.(error, {
        runId: run.id,
        projectId: run.projectId,
        code: classified.code
      });
    }
  } finally {
    try {
      await recordRunUsage(db, {
        runId: run.id,
        modelTokens,
        sandboxDurationSeconds: sandboxStartedAt
          ? Math.max(1, Math.ceil((Date.now() - sandboxStartedAt) / 1_000))
          : 0,
        attemptCount: retryCount
      });
    } catch (error) {
      hooks.onError?.(error, {
        runId: run.id,
        projectId: run.projectId,
        code: errorCodes.INTERNAL_ERROR
      });
    }
  }

  return true;
}

export async function startWorker(
  db: Database,
  options: {
    workerId: string;
    pollIntervalMs: number;
    staleAfterMs?: number;
    planner?: Planner;
    coder?: Coder;
    coderFactory?: CoderFactory;
    validationOptions?: ValidationOptions;
    snapshotStore?: SnapshotStore;
    hooks?: RuntimeHooks;
    runtimeJobHandler?: RuntimeJobHandler;
    signal?: AbortSignal;
  }
) {
  while (!options.signal?.aborted) {
    if (options.staleAfterMs) {
      await recoverStaleRuns(db, new Date(Date.now() - options.staleAfterMs));
      await recoverStaleRuntimeJobs(db, new Date(Date.now() - options.staleAfterMs));
    }
    if (options.runtimeJobHandler)
      await processNextRuntimeJob(
        db,
        options.workerId,
        options.runtimeJobHandler,
        options.hooks,
        Math.max(1_000, Math.floor((options.staleAfterMs ?? 30_000) / 3))
      );
    await processNextRun(
      db,
      options.workerId,
      options.planner,
      options.coder,
      options.coderFactory,
      options.validationOptions,
      options.snapshotStore,
      options.hooks
    );
    if (options.signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.pollIntervalMs);
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}

export function createWorkerDatabase(databaseUrl: string) {
  return createDatabaseClient(databaseUrl);
}
