import { pathToFileURL } from "node:url";

const minimumLimits = Object.freeze({
  maxOutputTokens: 8_000,
  maxTurns: 12,
  maxToolCalls: 30,
  maxTotalTokens: 100_000,
  maxRunDurationSeconds: 480
});

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the OpenAI readiness check.`);
  return value;
}

function positiveInteger(env, name, fallback) {
  const raw = env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a positive integer.`);
  return Number(raw);
}

function confirmed(env, name) {
  if (required(env, name) !== "true")
    throw new Error(`${name} must be exactly true after checking the OpenAI Project dashboard.`);
}

export function openAIAgentLimits(env = process.env) {
  const limits = {
    maxOutputTokens: positiveInteger(env, "OPENAI_MAX_OUTPUT_TOKENS", 12_000),
    maxTurns: positiveInteger(env, "MAX_AGENT_TURNS", 20),
    maxToolCalls: positiveInteger(env, "MAX_AGENT_TOOL_CALLS", 60),
    maxTotalTokens: positiveInteger(env, "MAX_AGENT_TOTAL_TOKENS", 200_000),
    maxRunDurationSeconds: positiveInteger(env, "MAX_RUN_DURATION_SECONDS", 600)
  };

  for (const [name, minimum] of Object.entries(minimumLimits)) {
    if (limits[name] < minimum)
      throw new Error(
        `${name} must be at least ${minimum} for the standard Todo acceptance workload.`
      );
  }
  return limits;
}

function providerFailure(status) {
  if (status === 401)
    return "OpenAI authentication failed (HTTP 401). Replace the Worker project API key.";
  if (status === 403 || status === 404)
    return `OpenAI model access failed (HTTP ${status}). Verify the project and model permissions.`;
  if (status === 429)
    return "OpenAI quota or rate limit was reached (HTTP 429). Check the project budget, balance, and rate limits.";
  if (status === 408 || status >= 500)
    return `OpenAI was temporarily unavailable (HTTP ${status}). Retry after checking provider status.`;
  return `OpenAI readiness request failed with HTTP ${status}.`;
}

async function providerRequest(fetchImpl, url, init) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(60_000)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenAI could not be reached: ${message}. Check Worker outbound networking and retry.`
    );
  }
  if (!response.ok) throw new Error(providerFailure(response.status));
  return response;
}

export async function verifyOpenAIReadiness({ env = process.env, fetchImpl = fetch } = {}) {
  const apiKey = required(env, "OPENAI_API_KEY");
  const model = required(env, "OPENAI_MODEL");
  const limits = openAIAgentLimits(env);

  confirmed(env, "OPENAI_PROJECT_CONFIRMED");
  confirmed(env, "OPENAI_BUDGET_CONFIRMED");
  confirmed(env, "OPENAI_RATE_LIMIT_CONFIRMED");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
  await providerRequest(
    fetchImpl,
    `https://api.openai.com/v1/models/${encodeURIComponent(model)}`,
    { headers }
  );

  const response = await providerRequest(fetchImpl, "https://api.openai.com/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 1_024,
      input: "Call readiness_check exactly once with status set to ok. Do not return prose.",
      tools: [
        {
          type: "function",
          name: "readiness_check",
          description: "Confirms that Responses API tool calling is available.",
          strict: true,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { status: { type: "string", enum: ["ok"] } },
            required: ["status"]
          }
        }
      ],
      tool_choice: { type: "function", name: "readiness_check" }
    })
  });
  const body = await response.json().catch(() => undefined);
  const toolCall = body?.output?.find(
    (item) => item?.type === "function_call" && item?.name === "readiness_check"
  );
  let argumentsBody;
  try {
    argumentsBody = JSON.parse(toolCall?.arguments ?? "");
  } catch {
    argumentsBody = undefined;
  }
  if (argumentsBody?.status !== "ok")
    throw new Error("The configured model did not complete the required Responses API tool call.");

  const rateLimitRemaining = {
    requests: response.headers.get("x-ratelimit-remaining-requests") || "reported by dashboard",
    tokens: response.headers.get("x-ratelimit-remaining-tokens") || "reported by dashboard"
  };

  return {
    verifiedAt: new Date().toISOString(),
    model,
    limits,
    responsesApi: "verified",
    toolCalling: "verified",
    projectOwnership: "confirmed",
    budgetForFiveAcceptanceRuns: "confirmed",
    rateLimitsForFiveAcceptanceRuns: "confirmed",
    rateLimitRemaining,
    requestId: response.headers.get("x-request-id") || "not returned"
  };
}

export function formatOpenAIReadinessReport(result) {
  return `# OpenAI Readiness Record

| Field | Evidence |
| --- | --- |
| Verified at | ${result.verifiedAt} |
| Model | \`${result.model}\` |
| Responses API | ${result.responsesApi} |
| Required tool call | ${result.toolCalling} |
| Dedicated OpenAI Project | ${result.projectOwnership} |
| Budget/balance for five acceptance Runs | ${result.budgetForFiveAcceptanceRuns} |
| Rate limits for five acceptance Runs | ${result.rateLimitsForFiveAcceptanceRuns} |
| Remaining requests | ${result.rateLimitRemaining.requests} |
| Remaining tokens | ${result.rateLimitRemaining.tokens} |
| Request ID | \`${result.requestId}\` |
| Max output tokens / request | ${result.limits.maxOutputTokens} |
| Max cumulative tokens / Run | ${result.limits.maxTotalTokens} |
| Max turns / tool calls | ${result.limits.maxTurns} / ${result.limits.maxToolCalls} |
| Max Run duration | ${result.limits.maxRunDurationSeconds} seconds |
`;
}

async function main() {
  const result = await verifyOpenAIReadiness();
  process.stdout.write(formatOpenAIReadinessReport(result));
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
