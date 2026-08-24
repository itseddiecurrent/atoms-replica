export type PlanStep = {
  id: string;
  title: string;
  status: "pending";
};

export type ImplementationPlan = {
  summary: string;
  assumptions: string[];
  steps: PlanStep[];
  acceptanceCriteria: string[];
};

export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code: "OPENAI_ERROR" | "PLAN_INVALID"
  ) {
    super(message);
    this.name = "PlannerError";
  }
}

export const implementationPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          status: { type: "string", enum: ["pending"] }
        },
        required: ["id", "title", "status"]
      }
    },
    acceptanceCriteria: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "assumptions", "steps", "acceptanceCriteria"]
} as const;

const plannerSystemPrompt = `You are the planning phase of an AI app builder.
Create a short, practical implementation plan for a frontend web app.
The app must use the fixed React, Vite, TypeScript, and Tailwind template.
Do not promise a production backend, authentication, payments, or deployment.
Return only the requested structured plan. Keep it concise and concrete.`;

function isImplementationPlan(value: unknown): value is ImplementationPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  if (typeof plan.summary !== "string") return false;
  if (
    !Array.isArray(plan.assumptions) ||
    !plan.assumptions.every((item) => typeof item === "string")
  )
    return false;
  if (
    !Array.isArray(plan.acceptanceCriteria) ||
    !plan.acceptanceCriteria.every((item) => typeof item === "string")
  )
    return false;
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 8) return false;
  return plan.steps.every((step) => {
    if (!step || typeof step !== "object") return false;
    const item = step as Record<string, unknown>;
    return (
      typeof item.id === "string" && typeof item.title === "string" && item.status === "pending"
    );
  });
}

type PlannerOptions = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  onProviderCall?: (call: {
    durationMs: number;
    status: "ok" | "error";
    requestId?: string;
  }) => void;
};

export function createPlanner(options: PlannerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let pendingTokens = 0;
  let pendingRetries = 0;

  return {
    consumeMetrics() {
      const metrics = { totalTokens: pendingTokens, retryCount: pendingRetries };
      pendingTokens = 0;
      pendingRetries = 0;
      return metrics;
    },
    async createPlan(prompt: string): Promise<ImplementationPlan> {
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const startedAt = Date.now();
        let providerReported = false;
        try {
          const response = await fetchImpl("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json"
            },
            signal: AbortSignal.timeout(options.requestTimeoutMs ?? 60_000),
            body: JSON.stringify({
              model: options.model,
              store: false,
              max_output_tokens: options.maxOutputTokens,
              input: [
                { role: "system", content: [{ type: "input_text", text: plannerSystemPrompt }] },
                { role: "user", content: [{ type: "input_text", text: prompt }] }
              ],
              text: {
                format: {
                  type: "json_schema",
                  name: "implementation_plan",
                  strict: true,
                  schema: implementationPlanJsonSchema
                }
              }
            })
          });

          const requestId = response.headers?.get("x-request-id");
          options.onProviderCall?.({
            durationMs: Date.now() - startedAt,
            status: response.ok ? "ok" : "error",
            ...(requestId ? { requestId } : {})
          });
          providerReported = true;
          if (!response.ok) {
            const detail = await responseErrorMessage(response);
            throw new PlannerError(
              openAIHttpErrorMessage(response.status, detail, "OpenAI"),
              "OPENAI_ERROR"
            );
          }
          const body = (await response.json()) as {
            output_text?: string;
            output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
            usage?: { total_tokens?: number };
          };
          pendingTokens += body.usage?.total_tokens ?? 0;
          const outputText =
            body.output_text ??
            body.output
              ?.flatMap((item) => item.content ?? [])
              .find((item) => item.type === "output_text")?.text;
          if (!outputText)
            throw new PlannerError("OpenAI returned no structured plan.", "PLAN_INVALID");
          const parsed: unknown = JSON.parse(outputText);
          if (!isImplementationPlan(parsed))
            throw new PlannerError(
              "OpenAI returned an invalid implementation plan.",
              "PLAN_INVALID"
            );
          return parsed;
        } catch (error) {
          if (!providerReported)
            options.onProviderCall?.({ durationMs: Date.now() - startedAt, status: "error" });
          lastError = error;
          if (error instanceof PlannerError && error.code === "OPENAI_ERROR") break;
          if (attempt === 0) pendingRetries += 1;
        }
      }

      if (lastError instanceof PlannerError) throw lastError;
      throw new PlannerError(
        `OpenAI could not be reached: ${describeRequestError(lastError)}. Check Worker outbound networking and retry.`,
        "OPENAI_ERROR"
      );
    }
  };
}

export const agentPackageStatus = "planner-ready" as const;

export type CoderSandbox = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  listFiles(path?: string): Promise<string[]>;
  runCommand(
    command: string,
    options?: { cwd?: string; timeoutMs?: number }
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  kill?(): Promise<void>;
};

export const coderToolDefinitions = [
  {
    type: "function",
    name: "read_file",
    description: "Read one text file from the project workspace.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    type: "function",
    name: "write_file",
    description: "Create or replace one text file in the project workspace.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  {
    type: "function",
    name: "apply_patch",
    description: "Replace exactly one existing text fragment in one project file.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" }
      },
      required: ["path", "oldText", "newText"]
    }
  },
  {
    type: "function",
    name: "delete_file",
    description: "Delete one project file.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  {
    type: "function",
    name: "list_files",
    description: "List project files, optionally below a relative directory.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: ["string", "null"] } },
      required: ["path"]
    }
  },
  {
    type: "function",
    name: "run_command",
    description: "Run a project validation or build command in the sandbox.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: ["string", "null"] }
      },
      required: ["command", "cwd"]
    }
  },
  {
    type: "function",
    name: "finish",
    description: "Declare that coding is complete and the project is ready for validation.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { summary: { type: "string" } },
      required: ["summary"]
    }
  }
] as const;

export type CoderEvent = {
  type:
    | "assistant.delta"
    | "tool.started"
    | "tool.completed"
    | "file.created"
    | "file.updated"
    | "file.deleted"
    | "command.output";
  payload: Record<string, unknown>;
};

export class CoderError extends Error {
  constructor(
    message: string,
    public readonly code: "CODER_ERROR" | "CODER_LIMIT" | "CODER_INVALID_TOOL" | "CODER_CANCELLED",
    public readonly retryable = false,
    public readonly limit?: "duration" | "tokens" | "tool_calls" | "turns"
  ) {
    super(message);
    this.name = "CoderError";
  }
}

export type CoderOptions = {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  maxTurns?: number;
  maxToolCalls?: number;
  maxTotalTokens?: number;
  maxDurationMs?: number;
  commandTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxRequestAttempts?: number;
  retryDelayMs?: number;
  cancellationPollMs?: number;
  fetchImpl?: typeof fetch;
  onEvent?: (event: CoderEvent) => Promise<void> | void;
  onFileChanged?: (path: string, action: "updated" | "deleted") => Promise<void> | void;
  shouldCancel?: () => Promise<boolean>;
  onProviderCall?: (call: {
    durationMs: number;
    status: "ok" | "error";
    requestId?: string;
  }) => void;
};

export type CoderInput = {
  prompt: string;
  plan: ImplementationPlan;
  fileTree: string[];
  recentContext?: string;
};

const coderSystemPrompt = `You are the coding phase of an AI app builder.
Use only the fixed React, Vite, TypeScript, and Tailwind project in /home/user/app.
Use tools for every file or command operation. Never claim a change without using a tool.
Use npm for install, build, test, and dev commands inside the sandbox; pnpm is not installed there.
Do not start a Vite development server; the Worker starts the production Preview after validation.
Keep changes focused on the user's request and do not add a backend, secrets, or deployment configuration.
Run a build or other useful validation before calling finish. Calling finish only hands control to validation; it does not mark the run completed.`;

function jsonArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CoderError("Tool arguments must be a JSON object.", "CODER_INVALID_TOOL");
  }
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  if (typeof args[name] !== "string")
    throw new CoderError(`Missing string argument: ${name}`, "CODER_INVALID_TOOL");
  return args[name];
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value !== null && value !== undefined && typeof value !== "string") {
    throw new CoderError(`Invalid string argument: ${name}`, "CODER_INVALID_TOOL");
  }
  return value ?? undefined;
}

function transientError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof CoderError && error.retryable);
}

function describeRequestError(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown network error.";
  const cause = error.cause;
  if (!cause || typeof cause !== "object") return error.message;
  const detail = cause as { code?: unknown; message?: unknown };
  const code = typeof detail.code === "string" ? detail.code : undefined;
  const message = typeof detail.message === "string" ? detail.message : undefined;
  return [error.message, code, message].filter(Boolean).join(": ");
}

async function responseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string };
    };
    const detail = body.error?.message ?? body.error?.code;
    if (detail) return detail.slice(0, 1_000);
  } catch {
    // Some proxy errors have no JSON response body.
  }
  return response.statusText || "OpenAI returned an error without details.";
}

function openAIHttpErrorMessage(status: number, detail: string, actor: string): string {
  const prefix = `${actor} request failed with HTTP ${status}: ${detail}`;
  if (status === 401) return `${prefix} Verify the Worker OPENAI_API_KEY.`;
  if (status === 403 || status === 404)
    return `${prefix} Verify the OpenAI Project and model permissions.`;
  if (status === 429)
    return `${prefix} Check the OpenAI Project budget, balance, and model rate limits, then retry.`;
  if (status === 408 || status >= 500)
    return `${prefix} OpenAI is temporarily unavailable; retry the Run.`;
  return `${prefix}.`;
}

export function createCoder(options: CoderOptions, sandbox: CoderSandbox) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxTurns = options.maxTurns ?? 20;
  const maxToolCalls = options.maxToolCalls ?? 40;
  const maxTotalTokens = options.maxTotalTokens ?? 200_000;
  const maxDurationMs = options.maxDurationMs ?? 10 * 60 * 1000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const maxRequestAttempts = options.maxRequestAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const cancellationPollMs = options.cancellationPollMs ?? 500;
  let requestRetries = 0;
  let pendingTokens = 0;
  let pendingRetries = 0;

  async function emit(event: CoderEvent): Promise<void> {
    await options.onEvent?.(event);
  }

  async function callModel(input: unknown[]): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRequestAttempts; attempt += 1) {
      const requestStartedAt = Date.now();
      let providerReported = false;
      try {
        const response = await fetchImpl("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json"
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
          body: JSON.stringify({
            model: options.model,
            store: false,
            max_output_tokens: options.maxOutputTokens,
            input,
            tools: coderToolDefinitions,
            tool_choice: "auto"
          })
        });
        const requestId = response.headers?.get("x-request-id");
        options.onProviderCall?.({
          durationMs: Date.now() - requestStartedAt,
          status: response.ok ? "ok" : "error",
          ...(requestId ? { requestId } : {})
        });
        providerReported = true;
        if (!response.ok) {
          const detail = await responseErrorMessage(response);
          throw new CoderError(
            openAIHttpErrorMessage(response.status, detail, "Coder"),
            "CODER_ERROR",
            response.status === 408 ||
              response.status === 409 ||
              response.status === 429 ||
              response.status >= 500
          );
        }
        return (await response.json()) as Record<string, unknown>;
      } catch (error) {
        if (!providerReported)
          options.onProviderCall?.({ durationMs: Date.now() - requestStartedAt, status: "error" });
        lastError = error;
        if (!transientError(error) || attempt === maxRequestAttempts - 1) break;
        requestRetries += 1;
        pendingRetries += 1;
        await new Promise((resolvePromise) =>
          setTimeout(resolvePromise, retryDelayMs * 2 ** attempt)
        );
      }
    }
    throw lastError instanceof CoderError
      ? lastError
      : new CoderError(
          `Coder could not reach OpenAI: ${describeRequestError(lastError)}. Check Worker outbound networking and retry.`,
          "CODER_ERROR"
        );
  }

  async function executeTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ output: string; finished?: string }> {
    switch (name) {
      case "read_file":
        return { output: await sandbox.readFile(stringArg(args, "path")) };
      case "write_file": {
        const path = stringArg(args, "path");
        await sandbox.writeFile(path, stringArg(args, "content"));
        await options.onFileChanged?.(path, "updated");
        await emit({ type: "file.updated", payload: { path } });
        return { output: `Wrote ${path}` };
      }
      case "apply_patch": {
        const path = stringArg(args, "path");
        const oldText = stringArg(args, "oldText");
        const content = await sandbox.readFile(path);
        const occurrences = content.split(oldText).length - 1;
        if (occurrences !== 1)
          throw new CoderError(`Patch must match exactly once in ${path}.`, "CODER_INVALID_TOOL");
        await sandbox.writeFile(path, content.replace(oldText, stringArg(args, "newText")));
        await options.onFileChanged?.(path, "updated");
        await emit({ type: "file.updated", payload: { path } });
        return { output: `Patched ${path}` };
      }
      case "delete_file": {
        const path = stringArg(args, "path");
        await sandbox.deleteFile(path);
        await options.onFileChanged?.(path, "deleted");
        await emit({ type: "file.deleted", payload: { path } });
        return { output: `Deleted ${path}` };
      }
      case "list_files":
        return { output: JSON.stringify(await sandbox.listFiles(optionalStringArg(args, "path"))) };
      case "run_command": {
        const command = stringArg(args, "command");
        const cwd = optionalStringArg(args, "cwd");
        let polling = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancellation = new Promise<never>((_resolve, reject) => {
          const poll = async () => {
            if (!polling) return;
            if (await options.shouldCancel?.()) {
              polling = false;
              if (sandbox.kill) await sandbox.kill().catch(() => undefined);
              reject(new CoderError("Run cancelled.", "CODER_CANCELLED"));
              return;
            }
            timer = setTimeout(poll, cancellationPollMs);
          };
          timer = setTimeout(poll, cancellationPollMs);
        });
        let result;
        try {
          result = await Promise.race([
            sandbox.runCommand(command, {
              ...(cwd ? { cwd } : {}),
              timeoutMs: commandTimeoutMs
            }),
            cancellation
          ]);
        } finally {
          polling = false;
          if (timer) clearTimeout(timer);
        }
        const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
        await emit({
          type: "command.output",
          payload: { command, output, exitCode: result.exitCode }
        });
        return { output: JSON.stringify({ exitCode: result.exitCode, output }) };
      }
      case "finish":
        return {
          output: "Coding finished; validation must run next.",
          finished: stringArg(args, "summary")
        };
      default:
        throw new CoderError(`Unsupported tool: ${name}`, "CODER_INVALID_TOOL");
    }
  }

  return {
    consumeMetrics() {
      const metrics = { totalTokens: pendingTokens, retryCount: pendingRetries };
      pendingTokens = 0;
      pendingRetries = 0;
      return metrics;
    },
    async run(input: CoderInput): Promise<{
      summary: string;
      turns: number;
      toolCalls: number;
      totalTokens: number;
      retryCount: number;
    }> {
      const startedAt = Date.now();
      const retriesAtStart = requestRetries;
      let turns = 0;
      let toolCalls = 0;
      let totalTokens = 0;
      let currentInput: unknown[] = [
        { role: "system", content: [{ type: "input_text", text: coderSystemPrompt }] },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({ ...input, recentContext: input.recentContext ?? "" })
            }
          ]
        }
      ];

      while (turns < maxTurns) {
        if (await options.shouldCancel?.())
          throw new CoderError("Run cancelled.", "CODER_CANCELLED");
        if (Date.now() - startedAt > maxDurationMs)
          throw new CoderError("Coder duration limit exceeded.", "CODER_LIMIT", false, "duration");
        turns += 1;
        const response = await callModel(currentInput);
        const usage = response.usage as { total_tokens?: number } | undefined;
        totalTokens += usage?.total_tokens ?? 0;
        pendingTokens += usage?.total_tokens ?? 0;
        if (totalTokens > maxTotalTokens)
          throw new CoderError("Coder token limit exceeded.", "CODER_LIMIT", false, "tokens");
        const output = Array.isArray(response.output) ? response.output : [];
        currentInput = [...currentInput, ...output];
        const outputText = typeof response.output_text === "string" ? response.output_text : "";
        if (outputText) await emit({ type: "assistant.delta", payload: { text: outputText } });

        let finishSummary: string | undefined;
        for (const item of output) {
          if (!item || typeof item !== "object") continue;
          const call = item as Record<string, unknown>;
          if (call.type !== "function_call") continue;
          if (await options.shouldCancel?.())
            throw new CoderError("Run cancelled.", "CODER_CANCELLED");
          toolCalls += 1;
          if (toolCalls > maxToolCalls)
            throw new CoderError(
              "Coder tool-call limit exceeded.",
              "CODER_LIMIT",
              false,
              "tool_calls"
            );
          const name = typeof call.name === "string" ? call.name : "";
          const callId = typeof call.call_id === "string" ? call.call_id : "";
          if (!name || !callId)
            throw new CoderError("Invalid function call returned by model.", "CODER_INVALID_TOOL");
          let args: Record<string, unknown>;
          try {
            args = jsonArguments(
              JSON.parse(typeof call.arguments === "string" ? call.arguments : "{}")
            );
          } catch (error) {
            throw error instanceof CoderError
              ? error
              : new CoderError("Invalid tool JSON.", "CODER_INVALID_TOOL");
          }
          await emit({ type: "tool.started", payload: { tool: name, input: args } });
          try {
            const result = await executeTool(name, args);
            await emit({
              type: "tool.completed",
              payload: { tool: name, success: true, output: result.output }
            });
            currentInput.push({
              type: "function_call_output",
              call_id: callId,
              output: result.output
            });
            if (result.finished) finishSummary = result.finished;
          } catch (error) {
            if (error instanceof CoderError && error.code === "CODER_CANCELLED") throw error;
            const message = error instanceof Error ? error.message : "Tool execution failed.";
            await emit({
              type: "tool.completed",
              payload: { tool: name, success: false, output: message }
            });
            currentInput.push({
              type: "function_call_output",
              call_id: callId,
              output: `Tool failed: ${message}`
            });
          }
        }
        if (finishSummary)
          return {
            summary: finishSummary,
            turns,
            toolCalls,
            totalTokens,
            retryCount: requestRetries - retriesAtStart
          };
        if (
          !output.some(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "function_call"
          )
        ) {
          throw new CoderError("Coder stopped without calling finish.", "CODER_ERROR");
        }
      }
      throw new CoderError("Coder turn limit exceeded.", "CODER_LIMIT", false, "turns");
    }
  };
}
