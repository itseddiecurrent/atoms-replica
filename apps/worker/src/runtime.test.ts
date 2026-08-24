import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImplementationPlan } from "@atom-replica/agent";

const {
  claimNextRun,
  claimNextRuntimeJob,
  appendRunEvent,
  beginRunCoding,
  beginRunValidation,
  createSnapshot,
  finalizeRun,
  heartbeatRun,
  heartbeatRuntimeJob,
  completeRun,
  completeRuntimeJob,
  failRun,
  failRuntimeJob,
  recoverStaleRuns,
  recoverStaleRuntimeJobs,
  pruneProjectSnapshots,
  getMessageContent,
  getProjectAgentContext,
  isRunCancelled,
  recordRunUsage,
  saveProjectPreview,
  saveRunPlan,
  upsertProjectFile
} = vi.hoisted(() => ({
  claimNextRun: vi.fn(),
  claimNextRuntimeJob: vi.fn(),
  appendRunEvent: vi.fn(),
  beginRunCoding: vi.fn(),
  beginRunValidation: vi.fn(),
  createSnapshot: vi.fn(),
  finalizeRun: vi.fn(),
  heartbeatRun: vi.fn(),
  heartbeatRuntimeJob: vi.fn(),
  completeRun: vi.fn(),
  completeRuntimeJob: vi.fn(),
  failRun: vi.fn(),
  failRuntimeJob: vi.fn(),
  recoverStaleRuns: vi.fn(),
  recoverStaleRuntimeJobs: vi.fn(),
  pruneProjectSnapshots: vi.fn(),
  getMessageContent: vi.fn(),
  getProjectAgentContext: vi.fn(),
  isRunCancelled: vi.fn(),
  recordRunUsage: vi.fn(),
  saveProjectPreview: vi.fn(),
  saveRunPlan: vi.fn(),
  upsertProjectFile: vi.fn()
}));

vi.mock("@atom-replica/db", () => ({
  claimNextRun,
  claimNextRuntimeJob,
  appendRunEvent,
  beginRunCoding,
  beginRunValidation,
  createSnapshot,
  finalizeRun,
  heartbeatRun,
  heartbeatRuntimeJob,
  completeRun,
  completeRuntimeJob,
  failRun,
  failRuntimeJob,
  recoverStaleRuns,
  recoverStaleRuntimeJobs,
  pruneProjectSnapshots,
  getMessageContent,
  getProjectAgentContext,
  isRunCancelled,
  recordRunUsage,
  saveProjectPreview,
  saveRunPlan,
  upsertProjectFile,
  createDatabaseClient: vi.fn()
}));

import {
  RuntimeJobProcessingError,
  getWorkerMode,
  processNextRun,
  processNextRuntimeJob
} from "./runtime";

describe("getWorkerMode", () => {
  it("disables polling only for the explicit true value", () => {
    expect(getWorkerMode("true")).toBe("disabled");
    expect(getWorkerMode("false")).toBe("polling");
    expect(getWorkerMode(undefined)).toBe("polling");
  });
});

describe("processNextRuntimeJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes a durable runtime operation", async () => {
    claimNextRuntimeJob.mockResolvedValue({
      id: "job-1",
      projectId: "project-1",
      type: "restart_preview",
      payloadJson: {}
    });
    const handler = vi.fn().mockResolvedValue({ previewUrl: "https://preview.example.com" });
    await expect(processNextRuntimeJob("database" as never, "worker-1", handler)).resolves.toBe(
      true
    );
    expect(completeRuntimeJob).toHaveBeenCalledWith("database", {
      runtimeJobId: "job-1",
      workerId: "worker-1",
      result: { previewUrl: "https://preview.example.com" }
    });
    expect(failRuntimeJob).not.toHaveBeenCalled();
  });

  it("stores a safe failure and reports the original error", async () => {
    claimNextRuntimeJob.mockResolvedValue({
      id: "job-1",
      projectId: "project-1",
      type: "sync_file",
      payloadJson: { path: "src/App.tsx" }
    });
    const onError = vi.fn();
    await processNextRuntimeJob(
      "database" as never,
      "worker-1",
      vi.fn().mockRejectedValue(new Error("provider secret detail")),
      { onError }
    );
    expect(failRuntimeJob).toHaveBeenCalledWith("database", {
      runtimeJobId: "job-1",
      workerId: "worker-1",
      code: "RUNTIME_OPERATION_FAILED",
      message: "Runtime operation failed. Retry the operation."
    });
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ projectId: "project-1", code: "SANDBOX_FAILED" })
    );
    expect((onError.mock.calls[0]?.[0] as Error).message).not.toContain("provider secret detail");
  });

  it("persists a safe stage code without exposing the provider cause", async () => {
    claimNextRuntimeJob.mockResolvedValue({
      id: "job-1",
      projectId: "project-1",
      type: "restart_preview",
      payloadJson: {}
    });
    await processNextRuntimeJob(
      "database" as never,
      "worker-1",
      vi.fn().mockRejectedValue(
        new RuntimeJobProcessingError("PREVIEW_SAVE_FAILED", "Could not save the Preview URL.", {
          cause: new Error("secret provider response")
        })
      )
    );
    expect(failRuntimeJob).toHaveBeenCalledWith("database", {
      runtimeJobId: "job-1",
      workerId: "worker-1",
      code: "PREVIEW_SAVE_FAILED",
      message: "Could not save the Preview URL."
    });
  });
});

describe("processNextRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    heartbeatRun.mockResolvedValue(undefined);
    pruneProjectSnapshots.mockResolvedValue([]);
    getProjectAgentContext.mockResolvedValue({ files: [], messages: [] });
    isRunCancelled.mockResolvedValue(false);
  });

  it("claims a queued run, emits progress, and completes it", async () => {
    claimNextRun.mockResolvedValue({ id: "run-1", projectId: "project-1" });
    getMessageContent.mockResolvedValue("Build a dashboard");

    await expect(processNextRun("database" as never, "worker-1")).resolves.toBe(true);

    expect(claimNextRun).toHaveBeenCalledWith("database", "worker-1");
    expect(heartbeatRun).toHaveBeenCalledWith("database", "run-1", "worker-1");
    expect(completeRun).toHaveBeenCalledWith("database", {
      runId: "run-1",
      projectId: "project-1",
      workerId: "worker-1"
    });
    expect(appendRunEvent).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ type: "run.completed" })
    );
  });

  it("keeps heartbeating while a provider call is still in progress", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    let resolvePlan!: (plan: ImplementationPlan) => void;
    const planner = {
      createPlan: vi.fn(
        () =>
          new Promise<ImplementationPlan>((resolve) => {
            resolvePlan = resolve;
          })
      )
    };

    const processing = processNextRun(
      "database" as never,
      "worker-1",
      planner,
      undefined,
      undefined,
      { heartbeatIntervalMs: 1 }
    );
    await vi.waitFor(() => expect(heartbeatRun).toHaveBeenCalled());
    resolvePlan({ summary: "Plan", assumptions: [], steps: [], acceptanceCriteria: [] });
    await expect(processing).resolves.toBe(true);
  });

  it("does nothing when no queued run is available", async () => {
    claimNextRun.mockResolvedValue(null);

    await expect(processNextRun("database" as never, "worker-1")).resolves.toBe(false);
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("runs the coder and enters validation after finish instead of completing", async () => {
    claimNextRun.mockResolvedValue({ id: "run-1", projectId: "project-1" });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi.fn().mockResolvedValue({ summary: "Coded", turns: 2, toolCalls: 3, totalTokens: 30 })
    };

    await expect(processNextRun("database" as never, "worker-1", undefined, coder)).resolves.toBe(
      true
    );

    expect(beginRunCoding).toHaveBeenCalledWith("database", "run-1", "worker-1");
    expect(coder.run).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Build a dashboard" })
    );
    expect(beginRunValidation).toHaveBeenCalledWith("database", "run-1", "worker-1");
    expect(completeRun).not.toHaveBeenCalled();
    expect(appendRunEvent).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ type: "run.validating" })
    );
  });

  it("installs, builds, starts a healthy preview, and completes the run", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi
        .fn()
        .mockResolvedValue({ summary: "Dashboard ready", turns: 2, toolCalls: 3, totalTokens: 30 })
    };
    const sandbox = {
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "built", stderr: "" }),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn().mockResolvedValue("https://preview.example.com"),
      kill: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      processNextRun(
        "database" as never,
        "worker-1",
        undefined,
        undefined,
        vi.fn().mockResolvedValue({ coder, sandbox }),
        { previewPort: 5173 }
      )
    ).resolves.toBe(true);

    expect(sandbox.runCommand).toHaveBeenNthCalledWith(1, "npm install --no-audit --no-fund", {
      timeoutMs: 120_000
    });
    expect(sandbox.runCommand).toHaveBeenNthCalledWith(2, "npm run build", {
      timeoutMs: 120_000
    });
    expect(sandbox.startDevServer).toHaveBeenCalledWith({ port: 5173 });
    expect(saveProjectPreview).toHaveBeenCalledWith("database", {
      projectId: "project-1",
      previewUrl: "https://preview.example.com"
    });
    expect(appendRunEvent).toHaveBeenCalledWith("database", {
      runId: "run-1",
      type: "preview.ready",
      payload: { url: "https://preview.example.com" }
    });
    expect(completeRun).toHaveBeenCalled();
  });

  it("reports a missing Sandbox package manager as BUILD_FAILED with diagnostics", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi.fn().mockResolvedValue({ summary: "Coded", turns: 1, toolCalls: 1, totalTokens: 10 })
    };
    const sandbox = {
      runCommand: vi.fn().mockResolvedValue({
        exitCode: 127,
        stdout: "",
        stderr: "sh: npm: command not found"
      }),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn(),
      kill: vi.fn()
    };

    await processNextRun(
      "database" as never,
      "worker-1",
      undefined,
      undefined,
      vi.fn().mockResolvedValue({ coder, sandbox })
    );

    expect(appendRunEvent).toHaveBeenCalledWith("database", {
      runId: "run-1",
      type: "command.output",
      payload: {
        command: "npm install --no-audit --no-fund",
        output: "sh: npm: command not found",
        exitCode: 127
      }
    });
    expect(failRun).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({
        code: "BUILD_FAILED",
        message: expect.stringContaining("sh: npm: command not found")
      })
    );
    expect(sandbox.startDevServer).not.toHaveBeenCalled();
  });

  it("gives a failed build to the coder and succeeds after one repair", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi.fn().mockResolvedValue({ summary: "Coded", turns: 2, toolCalls: 3, totalTokens: 30 })
    };
    const sandbox = {
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "src/App.tsx: broken" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "built", stderr: "" }),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn().mockResolvedValue("https://preview.example.com"),
      kill: vi.fn()
    };

    await processNextRun(
      "database" as never,
      "worker-1",
      undefined,
      undefined,
      vi.fn().mockResolvedValue({ coder, sandbox }),
      { maxRepairAttempts: 2 }
    );

    expect(coder.run).toHaveBeenCalledTimes(2);
    expect(coder.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: "Repair the project so npm run build succeeds.",
        recentContext: expect.stringContaining("src/App.tsx: broken")
      })
    );
    expect(appendRunEvent).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ type: "validation.failed" })
    );
    expect(completeRun).toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
    expect(recordRunUsage).toHaveBeenCalledWith("database", {
      runId: "run-1",
      modelTokens: 60,
      sandboxDurationSeconds: 1,
      attemptCount: 1
    });
  });

  it("fails clearly after exhausting repair attempts", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi.fn().mockResolvedValue({ summary: "Coded", turns: 2, toolCalls: 3, totalTokens: 30 })
    };
    const failedBuild = { exitCode: 1, stdout: "", stderr: "TypeScript error" };
    const sandbox = {
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" })
        .mockResolvedValue(failedBuild),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn(),
      kill: vi.fn()
    };

    await processNextRun(
      "database" as never,
      "worker-1",
      undefined,
      undefined,
      vi.fn().mockResolvedValue({ coder, sandbox }),
      { maxRepairAttempts: 2 }
    );

    expect(coder.run).toHaveBeenCalledTimes(3);
    expect(failRun).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({
        code: "BUILD_FAILED",
        message: expect.stringContaining("TypeScript error")
      })
    );
    expect(sandbox.startDevServer).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("uploads a safe snapshot and finalizes before publishing completion", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi
        .fn()
        .mockResolvedValue({ summary: "Dashboard ready", turns: 2, toolCalls: 3, totalTokens: 30 })
    };
    const sandbox = {
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "built", stderr: "" }),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn().mockResolvedValue("https://preview.example.com"),
      listFiles: vi.fn().mockResolvedValue(["src/App.tsx", "package.json", ".env", "dist/app.js"]),
      readFile: vi.fn(async (path: string) => `contents:${path}`),
      kill: vi.fn()
    };
    const snapshotStore = { upload: vi.fn(), remove: vi.fn() };
    createSnapshot.mockResolvedValue({ id: "snapshot-1" });
    pruneProjectSnapshots.mockResolvedValue(["project-1/old-run.zip"]);

    await processNextRun(
      "database" as never,
      "worker-1",
      undefined,
      undefined,
      vi.fn().mockResolvedValue({ coder, sandbox }),
      {},
      snapshotStore
    );

    expect(sandbox.readFile).toHaveBeenCalledTimes(2);
    expect(upsertProjectFile).toHaveBeenCalledTimes(2);
    expect(snapshotStore.upload).toHaveBeenCalledWith(
      "project-1/run-1.zip",
      expect.any(Uint8Array)
    );
    expect(createSnapshot).toHaveBeenCalledWith("database", {
      projectId: "project-1",
      runId: "run-1",
      storageKey: "project-1/run-1.zip"
    });
    expect(snapshotStore.remove).toHaveBeenCalledWith(["project-1/old-run.zip"]);
    expect(finalizeRun).toHaveBeenCalledWith("database", {
      runId: "run-1",
      projectId: "project-1",
      workerId: "worker-1",
      summary:
        "Generated and saved 2 project files. Validation passed: dependency installation and production build both exited successfully. Preview is live. Agent summary: Dashboard ready"
    });
    expect(completeRun).not.toHaveBeenCalled();
    const completedEventCall = appendRunEvent.mock.calls.findIndex(
      ([, event]) => event.type === "run.completed"
    );
    expect(finalizeRun.mock.invocationCallOrder[0]).toBeLessThan(
      appendRunEvent.mock.invocationCallOrder[completedEventCall]!
    );
    expect(appendRunEvent).toHaveBeenCalledWith("database", {
      runId: "run-1",
      type: "run.completed",
      payload: expect.objectContaining({ snapshotId: "snapshot-1" })
    });
  });

  it("fails the run when snapshot upload fails and never publishes completion", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const coder = {
      run: vi.fn().mockResolvedValue({ summary: "Ready", turns: 1, toolCalls: 1, totalTokens: 10 })
    };
    const sandbox = {
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "installed", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "built", stderr: "" }),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn().mockResolvedValue("https://preview.example.com"),
      listFiles: vi.fn().mockResolvedValue(["src/App.tsx"]),
      readFile: vi.fn().mockResolvedValue("app"),
      kill: vi.fn()
    };

    await processNextRun(
      "database" as never,
      "worker-1",
      undefined,
      undefined,
      vi.fn().mockResolvedValue({ coder, sandbox }),
      {},
      { upload: vi.fn().mockRejectedValue(new Error("Storage unavailable")), remove: vi.fn() }
    );

    expect(failRun).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ code: "SNAPSHOT_FAILED", message: "Storage unavailable" })
    );
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(finalizeRun).not.toHaveBeenCalled();
    expect(appendRunEvent.mock.calls.some(([, event]) => event.type === "run.completed")).toBe(
      false
    );
  });

  it("cancels an active sandbox command without publishing a failed event", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    let cancelled = false;
    isRunCancelled.mockImplementation(async () => cancelled);
    const coder = {
      run: vi.fn().mockResolvedValue({ summary: "Coded", turns: 1, toolCalls: 1, totalTokens: 12 })
    };
    const sandbox = {
      runCommand: vi.fn(() => {
        cancelled = true;
        return new Promise<never>(() => undefined);
      }),
      startDevServer: vi.fn(),
      getPreviewUrl: vi.fn(),
      listFiles: vi.fn(),
      readFile: vi.fn(),
      kill: vi.fn().mockResolvedValue(undefined)
    };

    await expect(
      processNextRun(
        "database" as never,
        "worker-1",
        undefined,
        undefined,
        vi.fn().mockResolvedValue({ coder, sandbox }),
        { cancellationPollMs: 1 }
      )
    ).resolves.toBe(true);

    expect(sandbox.kill).toHaveBeenCalled();
    expect(failRun).not.toHaveBeenCalled();
    expect(appendRunEvent.mock.calls.some(([, event]) => event.type === "run.failed")).toBe(false);
    expect(recordRunUsage).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ runId: "run-1", modelTokens: 12 })
    );
  });

  it("maps the overall duration limit to RUN_TIMEOUT", async () => {
    claimNextRun.mockResolvedValue({ id: "run-1", projectId: "project-1" });

    await processNextRun("database" as never, "worker-1", undefined, undefined, undefined, {
      maxRunDurationMs: -1
    });

    expect(failRun).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ code: "RUN_TIMEOUT" })
    );
  });

  it("maps a Coder token budget limit to AI_LIMIT instead of RUN_TIMEOUT", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const error = Object.assign(new Error("Coder token limit exceeded."), {
      code: "CODER_LIMIT",
      limit: "tokens"
    });
    const coder = { run: vi.fn().mockRejectedValue(error) };

    await processNextRun("database" as never, "worker-1", undefined, coder);

    expect(failRun).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({ code: "AI_LIMIT", message: "Coder token limit exceeded." })
    );
  });

  it("maps OpenAI quota and permission failures to the durable AI_FAILED state", async () => {
    claimNextRun.mockResolvedValue({
      id: "run-1",
      projectId: "project-1",
      triggerMessageId: "message-1"
    });
    getMessageContent.mockResolvedValue("Build a dashboard");
    const error = Object.assign(
      new Error("OpenAI quota was reached. Check the Project budget and retry."),
      { code: "OPENAI_ERROR" }
    );
    const planner = { createPlan: vi.fn().mockRejectedValue(error) };

    await processNextRun("database" as never, "worker-1", planner);

    expect(failRun).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({
        code: "AI_FAILED",
        message: "OpenAI quota was reached. Check the Project budget and retry."
      })
    );
    expect(appendRunEvent).toHaveBeenCalledWith(
      "database",
      expect.objectContaining({
        type: "run.failed",
        payload: expect.objectContaining({ code: "AI_FAILED" })
      })
    );
  });
});
