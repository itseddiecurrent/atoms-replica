import { describe, expect, it, vi } from "vitest";

import {
  createCoder,
  createPlanner,
  implementationPlanJsonSchema,
  type CoderSandbox,
  type PlannerError
} from "./index";

function response(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    statusText: "Request failed",
    json: async () => body
  } as Response);
}

describe("createPlanner", () => {
  it("sends Responses API structured output and parses a plan", async () => {
    const fetchImpl = vi.fn().mockReturnValue(
      response({
        usage: { total_tokens: 42 },
        output_text: JSON.stringify({
          summary: "Build a hydration dashboard",
          assumptions: ["The app is client-side only."],
          steps: [{ id: "step-1", title: "Create dashboard layout", status: "pending" }],
          acceptanceCriteria: ["The dashboard renders daily water entries."]
        })
      })
    );
    const onProviderCall = vi.fn();
    const planner = createPlanner({
      apiKey: "key",
      model: "model",
      maxOutputTokens: 1000,
      fetchImpl,
      onProviderCall
    });
    const plan = await planner.createPlan("Build a hydration dashboard");
    const request = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      text: { format: { type: string; schema: unknown } };
    };

    expect(plan.steps[0]?.title).toBe("Create dashboard layout");
    expect(request.text.format.type).toBe("json_schema");
    expect(request.text.format.schema).toEqual(implementationPlanJsonSchema);
    expect(planner.consumeMetrics()).toEqual({ totalTokens: 42, retryCount: 0 });
    expect(planner.consumeMetrics()).toEqual({ totalTokens: 0, retryCount: 0 });
    expect(onProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", durationMs: expect.any(Number) })
    );
  });

  it("retries once when the structured plan is invalid", async () => {
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(response({ output_text: "not json" }))
      .mockReturnValueOnce(
        response({
          output_text: JSON.stringify({
            summary: "Valid",
            assumptions: [],
            steps: [{ id: "step-1", title: "Build", status: "pending" }],
            acceptanceCriteria: []
          })
        })
      );

    await expect(
      createPlanner({ apiKey: "key", model: "model", maxOutputTokens: 1000, fetchImpl }).createPlan(
        "Build an app"
      )
    ).resolves.toMatchObject({ summary: "Valid" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads structured text from the raw Responses output array", async () => {
    const fetchImpl = vi.fn().mockReturnValue(
      response({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  summary: "Raw response",
                  assumptions: [],
                  steps: [{ id: "step-1", title: "Build", status: "pending" }],
                  acceptanceCriteria: []
                })
              }
            ]
          }
        ]
      })
    );

    await expect(
      createPlanner({ apiKey: "key", model: "model", maxOutputTokens: 1000, fetchImpl }).createPlan(
        "Build an app"
      )
    ).resolves.toMatchObject({ summary: "Raw response" });
  });

  it("returns a stable error for OpenAI failures", async () => {
    const fetchImpl = vi.fn().mockReturnValue(response({}, false, 429));

    await expect(
      createPlanner({ apiKey: "key", model: "model", maxOutputTokens: 1000, fetchImpl }).createPlan(
        "Build an app"
      )
    ).rejects.toMatchObject({ code: "OPENAI_ERROR" } satisfies Partial<PlannerError>);
  });
});

describe("createCoder", () => {
  const plan = {
    summary: "Build a todo app",
    assumptions: [],
    steps: [{ id: "step-1", title: "Build UI", status: "pending" as const }],
    acceptanceCriteria: ["The app builds"]
  };

  function fakeSandbox(): CoderSandbox & { files: Map<string, string>; commands: string[] } {
    const files = new Map([["src/App.tsx", "old"]]);
    const commands: string[] = [];
    return {
      files,
      commands,
      readFile: vi.fn(async (path) => files.get(path) ?? ""),
      writeFile: vi.fn(async (path, content) => void files.set(path, content)),
      deleteFile: vi.fn(async (path) => void files.delete(path)),
      listFiles: vi.fn(async () => [...files.keys()]),
      runCommand: vi.fn(async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "build ok", stderr: "" };
      })
    };
  }

  it("executes tool calls, emits boundaries, and stops only after finish", async () => {
    const sandbox = fakeSandbox();
    const events: string[] = [];
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(
        response({
          usage: { total_tokens: 10 },
          output: [
            {
              type: "function_call",
              name: "apply_patch",
              call_id: "call-1",
              arguments: JSON.stringify({ path: "src/App.tsx", oldText: "old", newText: "new" })
            }
          ]
        })
      )
      .mockReturnValueOnce(
        response({
          usage: { total_tokens: 10 },
          output: [
            {
              type: "function_call",
              name: "run_command",
              call_id: "call-2",
              arguments: JSON.stringify({ command: "pnpm build", cwd: null })
            }
          ]
        })
      )
      .mockReturnValueOnce(
        response({
          usage: { total_tokens: 10 },
          output: [
            {
              type: "function_call",
              name: "finish",
              call_id: "call-3",
              arguments: JSON.stringify({ summary: "Implemented and built the app" })
            }
          ]
        })
      );

    const result = await createCoder(
      {
        apiKey: "key",
        model: "model",
        maxOutputTokens: 1000,
        fetchImpl,
        onEvent: (event) => {
          events.push(event.type);
        }
      },
      sandbox
    ).run({ prompt: "Build a todo app", plan, fileTree: ["src/App.tsx"] });

    expect(result).toMatchObject({
      summary: "Implemented and built the app",
      turns: 3,
      toolCalls: 3
    });
    expect(sandbox.files.get("src/App.tsx")).toBe("new");
    expect(sandbox.commands).toEqual(["pnpm build"]);
    expect(events).toEqual([
      "tool.started",
      "file.updated",
      "tool.completed",
      "tool.started",
      "command.output",
      "tool.completed",
      "tool.started",
      "tool.completed"
    ]);
  });

  it("does not execute tools after the tool-call limit", async () => {
    const sandbox = fakeSandbox();
    const fetchImpl = vi.fn().mockReturnValue(
      response({
        output: [
          {
            type: "function_call",
            name: "list_files",
            call_id: "call-1",
            arguments: JSON.stringify({ path: null })
          }
        ]
      })
    );
    await expect(
      createCoder(
        { apiKey: "key", model: "model", maxOutputTokens: 1000, maxToolCalls: 0, fetchImpl },
        sandbox
      ).run({ prompt: "Build", plan, fileTree: [] })
    ).rejects.toMatchObject({ code: "CODER_LIMIT" });
    expect(sandbox.listFiles).not.toHaveBeenCalled();
  });

  it("returns tool errors to the model and does not mark the run complete", async () => {
    const sandbox = fakeSandbox();
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(
        response({
          output: [
            { type: "function_call", name: "unknown_tool", call_id: "call-1", arguments: "{}" }
          ]
        })
      )
      .mockReturnValueOnce(
        response({
          output: [
            {
              type: "function_call",
              name: "finish",
              call_id: "call-2",
              arguments: JSON.stringify({ summary: "Stopped safely" })
            }
          ]
        })
      );
    await expect(
      createCoder({ apiKey: "key", model: "model", maxOutputTokens: 1000, fetchImpl }, sandbox).run(
        { prompt: "Build", plan, fileTree: [] }
      )
    ).resolves.toMatchObject({ summary: "Stopped safely" });
    const lastRequest = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as {
      input: Array<{ output?: string }>;
    };
    expect(lastRequest.input.some((item) => item.output?.includes("Tool failed"))).toBe(true);
  });

  it("retries transient network failures and preserves the root cause", async () => {
    const networkError = new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" })
    });
    const fetchImpl = vi.fn().mockRejectedValue(networkError);

    await expect(
      createCoder(
        {
          apiKey: "key",
          model: "model",
          maxOutputTokens: 1000,
          maxRequestAttempts: 3,
          retryDelayMs: 0,
          fetchImpl
        },
        fakeSandbox()
      ).run({ prompt: "Build", plan, fileTree: [] })
    ).rejects.toThrow("fetch failed: ECONNRESET: socket disconnected");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("surfaces non-retryable OpenAI response details", async () => {
    const fetchImpl = vi
      .fn()
      .mockReturnValue(response({ error: { message: "Invalid tools schema." } }, false, 400));

    await expect(
      createCoder(
        { apiKey: "key", model: "model", maxOutputTokens: 1000, fetchImpl },
        fakeSandbox()
      ).run({ prompt: "Build", plan, fileTree: [] })
    ).rejects.toThrow("HTTP 400: Invalid tools schema.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("checks cancellation before making another model request", async () => {
    const fetchImpl = vi.fn();
    await expect(
      createCoder(
        {
          apiKey: "key",
          model: "model",
          maxOutputTokens: 1000,
          fetchImpl,
          shouldCancel: async () => true
        },
        fakeSandbox()
      ).run({ prompt: "Build", plan, fileTree: [] })
    ).rejects.toMatchObject({ code: "CODER_CANCELLED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("terminates an active sandbox tool command when cancellation is requested", async () => {
    let cancelled = false;
    const sandbox = {
      ...fakeSandbox(),
      runCommand: vi.fn(() => {
        cancelled = true;
        return new Promise<never>(() => undefined);
      }),
      kill: vi.fn().mockResolvedValue(undefined)
    };
    const fetchImpl = vi.fn().mockReturnValue(
      response({
        output: [
          {
            type: "function_call",
            name: "run_command",
            call_id: "call-1",
            arguments: JSON.stringify({ command: "pnpm build", cwd: null })
          }
        ]
      })
    );

    await expect(
      createCoder(
        {
          apiKey: "key",
          model: "model",
          maxOutputTokens: 1000,
          fetchImpl,
          shouldCancel: async () => cancelled,
          cancellationPollMs: 1
        },
        sandbox
      ).run({ prompt: "Build", plan, fileTree: [] })
    ).rejects.toMatchObject({ code: "CODER_CANCELLED" });
    expect(sandbox.kill).toHaveBeenCalled();
  });
});
