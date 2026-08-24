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
  installCommand?: string;
  buildCommand?: string;
  installTimeoutMs?: number;
  buildTimeoutMs?: number;
  maxRunDurationMs?: number;
  cancellationPollMs?: number;
  heartbeatIntervalMs?: number;
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

export class RuntimeJobProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RuntimeJobProcessingError";
  }
}

function classifyRuntimeJobError(error: unknown) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  if (
    error instanceof RuntimeJobProcessingError ||
    (record.name === "SandboxLifecycleError" &&
      typeof record.code === "string" &&
      typeof record.message === "string")
  )
    return { code: String(record.code), message: String(record.message) };
  return {
    code: "RUNTIME_OPERATION_FAILED",
    message: "Runtime operation failed. Retry the operation."
  };
}

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
    const classified = classifyRuntimeJobError(error);
    await failRuntimeJob(db, {
      runtimeJobId: job.id,
      workerId,
      ...classified
    });
    hooks.onError?.(new Error(`${classified.code}: ${classified.message}`), {
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

async function appendStageProgress(
  db: Database,
  runId: string,
  payload: {
    stage: "planning" | "workspace" | "coding" | "validation" | "preview" | "saving";
    percent: number;
    title: string;
    detail?: string;
  }
) {
  await appendRunEvent(db, { runId, type: "stage.progress", payload });
}

function clearCompletionSummary(agentSummary: string, filesPersisted: number) {
  const fileResult =
    filesPersisted > 0
      ? `Generated and saved ${filesPersisted} project ${filesPersisted === 1 ? "file" : "files"}.`
      : "Generated and saved the project files.";
  return `${fileResult} Validation passed: dependency installation and production build both exited successfully. Preview is live. Agent summary: ${agentSummary}`;
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
  const heartbeat = setInterval(() => {
    void heartbeatRun(db, run.id, workerId).catch((error) =>
      hooks.onError?.(error, {
        runId: run.id,
        projectId: run.projectId,
        code: errorCodes.INTERNAL_ERROR
      })
    );
  }, validationOptions.heartbeatIntervalMs ?? 5_000);

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
    await appendStageProgress(db, run.id, {
      stage: "planning",
      percent: 10,
      title: "Understanding your request",
      detail: "Creating a concrete implementation plan and acceptance criteria."
    });
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
      await appendStageProgress(db, run.id, {
        stage: "workspace",
        percent: 20,
        title: "Preparing the remote workspace",
        detail: "Creating or restoring the E2B Sandbox and project files."
      });
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
      await appendStageProgress(db, run.id, {
        stage: "coding",
        percent: 30,
        title: "Generating project code",
        detail: "File and tool activity will appear below as it happens."
      });
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
      await appendStageProgress(db, run.id, {
        stage: "coding",
        percent: 60,
        title: "Code generation finished",
        detail: `${codingResult.turns} model turns and ${codingResult.toolCalls} tool calls completed.`
      });
      await beginRunValidation(db, run.id, workerId);
      await appendRunEvent(db, { runId: run.id, type: "run.validating", payload: {} });
      if (!runContext) return true;

      const installCommand = validationOptions.installCommand ?? "npm install --no-audit --no-fund";
      await appendStageProgress(db, run.id, {
        stage: "validation",
        percent: 65,
        title: "Installing project dependencies",
        detail: installCommand
      });
      const installResult = await runSandboxCommand(
        installCommand,
        validationOptions.installTimeoutMs ?? 120_000
      );
      await appendRunEvent(db, {
        runId: run.id,
        type: "command.output",
        payload: {
          command: installCommand,
          output: commandOutput(installResult),
          exitCode: installResult.exitCode
        }
      });
      if (installResult.exitCode !== 0) {
        throw new RunProcessingError(
          validationMessage(installCommand, commandOutput(installResult)),
          errorCodes.BUILD_FAILED
        );
      }

      const buildCommand = validationOptions.buildCommand ?? "npm run build";
      await appendStageProgress(db, run.id, {
        stage: "validation",
        percent: 75,
        title: "Building the generated app",
        detail: buildCommand
      });
      const maxRepairAttempts = validationOptions.maxRepairAttempts ?? 2;
      let buildResult = await runSandboxCommand(
        buildCommand,
        validationOptions.buildTimeoutMs ?? 120_000
      );
      await appendRunEvent(db, {
        runId: run.id,
        type: "command.output",
        payload: {
          command: buildCommand,
          output: commandOutput(buildResult),
          exitCode: buildResult.exitCode
        }
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
        await appendStageProgress(db, run.id, {
          stage: "coding",
          percent: 78 + attempt * 6,
          title: `Repairing the failed build (attempt ${attempt + 1}/${maxRepairAttempts})`,
          detail: message
        });
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
        await appendStageProgress(db, run.id, {
          stage: "validation",
          percent: 82 + attempt * 6,
          title: "Re-running the production build",
          detail: buildCommand
        });
        await heartbeatRun(db, run.id, workerId);
        buildResult = await runSandboxCommand(
          buildCommand,
          validationOptions.buildTimeoutMs ?? 120_000
        );
        await appendRunEvent(db, {
          runId: run.id,
          type: "command.output",
          payload: {
            command: buildCommand,
            output: commandOutput(buildResult),
            exitCode: buildResult.exitCode
          }
        });
      }

      let completedPreviewUrl: string | undefined;
      try {
        await checkBoundary();
        await appendStageProgress(db, run.id, {
          stage: "preview",
          percent: 88,
          title: "Starting the live Preview",
          detail: `Waiting for Vite on port ${validationOptions.previewPort ?? 5173}.`
        });
        await runContext.sandbox.startDevServer(
          validationOptions.previewPort ? { port: validationOptions.previewPort } : undefined
        );
        const previewUrl = await runContext.sandbox.getPreviewUrl(validationOptions.previewPort);
        completedPreviewUrl = previewUrl;
        await checkBoundary();
        await saveProjectPreview(db, { projectId: run.projectId, previewUrl });
        await appendRunEvent(db, {
          runId: run.id,
          type: "preview.ready",
          payload: { url: previewUrl }
        });
        await appendStageProgress(db, run.id, {
          stage: "preview",
          percent: 92,
          title: "Preview is live",
          detail: "The generated app responded successfully over HTTPS."
        });
      } catch (error) {
        throw new RunProcessingError(
          error instanceof Error ? error.message : "Preview failed to start.",
          error instanceof RunProcessingError ? error.code : errorCodes.SANDBOX_FAILED
        );
      }

      let filesPersisted = 0;
      if (snapshotStore) {
        try {
          await appendStageProgress(db, run.id, {
            stage: "saving",
            percent: 95,
            title: "Saving generated files",
            detail: "Persisting project files and creating a recoverable Snapshot."
          });
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
          filesPersisted = files.length;
          const storageKey = `${run.projectId}/${run.id}.zip`;
          await checkBoundary();
          await snapshotStore.upload(storageKey, createProjectZip(files));
          await createSnapshot(db, { projectId: run.projectId, runId: run.id, storageKey });
          const staleKeys = await pruneProjectSnapshots(db, run.projectId, 5);
          if (staleKeys.length) await snapshotStore.remove(staleKeys);
          const summary = clearCompletionSummary(codingResult.summary, filesPersisted);
          await finalizeRun(db, {
            runId: run.id,
            projectId: run.projectId,
            workerId,
            summary
          });
          await appendStageProgress(db, run.id, {
            stage: "saving",
            percent: 98,
            title: "Project saved",
            detail: `${filesPersisted} files persisted with a recoverable Snapshot.`
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
        payload: {
          summary: clearCompletionSummary(codingResult.summary, filesPersisted),
          filesPersisted,
          ...(completedPreviewUrl ? { previewUrl: completedPreviewUrl } : {}),
          validationCommands: [installCommand, buildCommand]
        }
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
    clearInterval(heartbeat);
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
