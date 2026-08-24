export type RunStreamEvent = {
  eventId: number;
  type: string;
  payload?: {
    text?: string;
    title?: string;
    summary?: string;
    message?: string;
    detail?: string;
    steps?: string[];
    url?: string;
    path?: string;
    code?: string;
    stage?: string;
    percent?: number;
    tool?: string;
    input?: Record<string, unknown>;
    success?: boolean;
    command?: string;
    output?: string;
    exitCode?: number;
    attempt?: number;
    filesPersisted?: number;
  };
};

export type ActivityItem = {
  id: number | string;
  title: string;
  detail?: string | undefined;
  tone: "info" | "working" | "success" | "error";
};

export type RunProgress = {
  percent: number;
  title: string;
  detail?: string | undefined;
  stage: string;
};

function truncated(value: string | undefined, length = 240) {
  if (!value) return undefined;
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized;
}

function toolTarget(event: RunStreamEvent) {
  const input = event.payload?.input;
  const path = typeof input?.path === "string" ? input.path : undefined;
  const command = typeof input?.command === "string" ? input.command : undefined;
  return path ?? command;
}

function toolTitle(tool: string | undefined) {
  const labels: Record<string, string> = {
    read_file: "Reading file",
    write_file: "Writing file",
    apply_patch: "Updating file",
    delete_file: "Deleting file",
    list_files: "Inspecting project files",
    run_command: "Running Agent command",
    finish: "Finalizing code generation"
  };
  return labels[tool ?? ""] ?? `Running ${tool || "Agent tool"}`;
}

export function activityFromRunEvent(event: RunStreamEvent): ActivityItem | undefined {
  const payload = event.payload ?? {};
  switch (event.type) {
    case "run.queued":
      return {
        id: event.eventId,
        title: "Run queued",
        detail: "Waiting for a Worker.",
        tone: "working"
      };
    case "run.planning":
      return { id: event.eventId, title: "Planning started", tone: "working" };
    case "run.coding":
      return { id: event.eventId, title: "Code generation started", tone: "working" };
    case "run.validating":
      return { id: event.eventId, title: "Independent validation started", tone: "working" };
    case "stage.progress":
      return {
        id: event.eventId,
        title: payload.title ?? "Generation progress",
        ...(payload.detail ? { detail: payload.detail } : {}),
        tone: "working"
      };
    case "plan.created":
      return {
        id: event.eventId,
        title: "Implementation plan ready",
        detail: truncated(payload.summary),
        tone: "success"
      };
    case "step.started":
      return {
        id: event.eventId,
        title: "Starting plan step",
        detail: payload.title,
        tone: "working"
      };
    case "assistant.delta":
      return {
        id: event.eventId,
        title: "Agent update",
        detail: truncated(payload.text),
        tone: "info"
      };
    case "tool.started":
      return {
        id: event.eventId,
        title: toolTitle(payload.tool),
        detail: truncated(toolTarget(event)),
        tone: "working"
      };
    case "tool.completed":
      return {
        id: event.eventId,
        title:
          payload.success === false
            ? `${toolTitle(payload.tool)} failed`
            : `${toolTitle(payload.tool)} completed`,
        tone: payload.success === false ? "error" : "success"
      };
    case "file.created":
    case "file.updated":
    case "file.deleted": {
      const action =
        event.type === "file.deleted"
          ? "Deleted"
          : event.type === "file.created"
            ? "Created"
            : "Updated";
      return { id: event.eventId, title: `${action} file`, detail: payload.path, tone: "success" };
    }
    case "command.output": {
      const exitCode = payload.exitCode;
      const passed = exitCode === undefined || exitCode === 0;
      const output = truncated(payload.output, 180);
      return {
        id: event.eventId,
        title: passed ? "Command passed" : "Command failed",
        detail: [
          `$ ${payload.command ?? "command"}`,
          exitCode === undefined ? undefined : `exit ${exitCode}`,
          output
        ]
          .filter(Boolean)
          .join(" · "),
        tone: passed ? "success" : "error"
      };
    }
    case "validation.failed":
      return {
        id: event.eventId,
        title: `Build validation failed${payload.attempt === undefined ? "" : ` (attempt ${payload.attempt + 1})`}`,
        detail: truncated(payload.message),
        tone: "error"
      };
    case "preview.ready":
      return {
        id: event.eventId,
        title: "HTTPS Preview is ready",
        detail: payload.url,
        tone: "success"
      };
    case "run.completed":
      return {
        id: event.eventId,
        title: "Generation completed",
        detail: truncated(payload.summary, 500),
        tone: "success"
      };
    case "run.failed":
      return {
        id: event.eventId,
        title: `Generation failed · ${payload.code ?? "INTERNAL_ERROR"}`,
        detail: truncated(payload.message),
        tone: "error"
      };
    case "run.cancelled":
      return { id: event.eventId, title: "Run cancelled", detail: payload.message, tone: "error" };
    default:
      return undefined;
  }
}

export function initialProgressForStatus(status: string | undefined): RunProgress {
  if (status === "queued") return { percent: 5, title: "Waiting for a Worker", stage: "queued" };
  if (status === "planning")
    return { percent: 10, title: "Understanding your request", stage: "planning" };
  if (status === "coding")
    return { percent: 30, title: "Generating project code", stage: "coding" };
  if (status === "validating")
    return { percent: 65, title: "Validating the generated app", stage: "validation" };
  if (status === "failed") return { percent: 0, title: "Generation failed", stage: "failed" };
  if (status === "cancelled") return { percent: 0, title: "Run cancelled", stage: "cancelled" };
  return { percent: 100, title: "Preview running", stage: "completed" };
}

export function progressFromRunEvent(current: RunProgress, event: RunStreamEvent): RunProgress {
  const payload = event.payload ?? {};
  if (event.type === "stage.progress" && typeof payload.percent === "number") {
    return {
      percent: Math.max(current.percent, payload.percent),
      title: payload.title ?? current.title,
      ...(payload.detail ? { detail: payload.detail } : {}),
      stage: payload.stage ?? current.stage
    };
  }
  if (event.type === "run.queued") return initialProgressForStatus("queued");
  if (event.type === "run.planning" && current.percent < 10)
    return initialProgressForStatus("planning");
  if (event.type === "run.coding" && current.percent < 30)
    return initialProgressForStatus("coding");
  if (event.type === "run.validating" && current.percent < 65)
    return initialProgressForStatus("validating");
  if (event.type === "run.completed")
    return {
      percent: 100,
      title: "Generation completed",
      detail: payload.summary,
      stage: "completed"
    };
  if (event.type === "run.failed")
    return {
      ...current,
      title: `Generation failed · ${payload.code ?? "INTERNAL_ERROR"}`,
      detail: payload.message,
      stage: "failed"
    };
  if (event.type === "run.cancelled")
    return { ...current, title: "Run cancelled", detail: payload.message, stage: "cancelled" };
  return current;
}
