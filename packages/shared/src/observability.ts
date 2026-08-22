export const errorCodes = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  RATE_LIMITED: "RATE_LIMITED",
  PLAN_INVALID: "PLAN_INVALID",
  SANDBOX_FAILED: "SANDBOX_FAILED",
  BUILD_FAILED: "BUILD_FAILED",
  RUN_TIMEOUT: "RUN_TIMEOUT",
  RUN_CANCELLED: "RUN_CANCELLED",
  AI_FAILED: "AI_FAILED",
  SNAPSHOT_FAILED: "SNAPSHOT_FAILED",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  INVALID_REQUEST: "INVALID_REQUEST",
  INTERNAL_ERROR: "INTERNAL_ERROR"
} as const;

export type ErrorCode = (typeof errorCodes)[keyof typeof errorCodes];

export function errorBody(code: ErrorCode, message: string) {
  return { code, error: message };
}

export type ProviderCall = {
  provider: "openai" | "e2b" | "supabase";
  operation: string;
  durationMs: number;
  status: "ok" | "error";
  requestId?: string;
};

export function logProviderCall(call: ProviderCall, logger = console.info) {
  logger(JSON.stringify({ type: "provider.call", ...call }));
}

export async function observeProviderCall<T>(
  call: Pick<ProviderCall, "provider" | "operation">,
  operation: () => Promise<T>,
  logger: (call: ProviderCall) => void = logProviderCall
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    logger({ ...call, durationMs: Date.now() - startedAt, status: "ok" });
    return result;
  } catch (error) {
    const requestId = providerRequestId(error);
    logger({
      ...call,
      durationMs: Date.now() - startedAt,
      status: "error",
      ...(requestId ? { requestId } : {})
    });
    throw error;
  }
}

function providerRequestId(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const value = record.requestId ?? record.request_id;
  return typeof value === "string" && value ? value : undefined;
}

export async function captureException(
  error: unknown,
  options: { dsn?: string; fetchImpl?: typeof fetch; context?: Record<string, unknown> } = {}
) {
  if (!options.dsn) return false;
  try {
    const dsn = new URL(options.dsn);
    const projectId = dsn.pathname.split("/").filter(Boolean).pop();
    if (!projectId) return false;
    const eventId = crypto.randomUUID().replaceAll("-", "");
    const event = {
      event_id: eventId,
      timestamp: new Date().toISOString(),
      level: "error",
      message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      extra: options.context ?? {}
    };
    const envelope = `${JSON.stringify({ event_id: eventId, dsn: options.dsn })}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}`;
    await (options.fetchImpl ?? fetch)(`${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/`, {
      method: "POST",
      body: envelope,
      headers: { "Content-Type": "application/x-sentry-envelope" }
    });
    return true;
  } catch {
    return false;
  }
}
