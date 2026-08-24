import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatOpenAIReadinessReport,
  openAIAgentLimits,
  verifyOpenAIReadiness
} from "./openai-readiness.mjs";

function environment(overrides = {}) {
  return {
    OPENAI_API_KEY: "test-only-value",
    OPENAI_MODEL: "test-model",
    OPENAI_MAX_OUTPUT_TOKENS: "12000",
    MAX_AGENT_TURNS: "20",
    MAX_AGENT_TOOL_CALLS: "60",
    MAX_AGENT_TOTAL_TOKENS: "200000",
    MAX_RUN_DURATION_SECONDS: "600",
    OPENAI_PROJECT_CONFIRMED: "true",
    OPENAI_BUDGET_CONFIRMED: "true",
    OPENAI_RATE_LIMIT_CONFIRMED: "true",
    ...overrides
  };
}

function successfulFetch(url) {
  if (String(url).includes("/v1/models/"))
    return Promise.resolve(Response.json({ id: "test-model" }));
  return Promise.resolve(
    Response.json(
      {
        output: [
          {
            type: "function_call",
            name: "readiness_check",
            arguments: JSON.stringify({ status: "ok" })
          }
        ]
      },
      {
        headers: {
          "x-request-id": "request-1",
          "x-ratelimit-remaining-requests": "499",
          "x-ratelimit-remaining-tokens": "999000"
        }
      }
    )
  );
}

describe("OpenAI production readiness verifier", () => {
  it("verifies model access, Responses API tools, limits, and dashboard confirmations", async () => {
    const result = await verifyOpenAIReadiness({
      env: environment(),
      fetchImpl: successfulFetch
    });

    assert.equal(result.model, "test-model");
    assert.equal(result.toolCalling, "verified");
    assert.equal(result.rateLimitRemaining.requests, "499");
    assert.equal(result.limits.maxTotalTokens, 200_000);
  });

  it("produces a report without the API key or response content", async () => {
    const env = environment();
    const result = await verifyOpenAIReadiness({ env, fetchImpl: successfulFetch });
    const report = formatOpenAIReadinessReport(result);

    assert.doesNotMatch(report, new RegExp(env.OPENAI_API_KEY));
    assert.doesNotMatch(report, /Authorization|input|arguments/);
    assert.match(report, /Required tool call \| verified/);
  });

  it("rejects limits that cannot support the standard Todo workload", () => {
    assert.throws(
      () => openAIAgentLimits(environment({ MAX_AGENT_TOTAL_TOKENS: "99999" })),
      /maxTotalTokens must be at least 100000/
    );
  });

  it("requires explicit project, budget, and rate-limit dashboard confirmation", async () => {
    await assert.rejects(
      verifyOpenAIReadiness({
        env: environment({ OPENAI_BUDGET_CONFIRMED: "false" }),
        fetchImpl: successfulFetch
      }),
      /OPENAI_BUDGET_CONFIRMED must be exactly true/
    );
  });

  it("returns actionable quota and model-permission failures", async () => {
    await assert.rejects(
      verifyOpenAIReadiness({
        env: environment(),
        fetchImpl: () => Promise.resolve(new Response(null, { status: 429 }))
      }),
      /quota or rate limit.*budget, balance, and rate limits/
    );
    await assert.rejects(
      verifyOpenAIReadiness({
        env: environment(),
        fetchImpl: () => Promise.resolve(new Response(null, { status: 403 }))
      }),
      /model access.*project and model permissions/
    );
  });

  it("fails when the model does not perform the required tool call", async () => {
    await assert.rejects(
      verifyOpenAIReadiness({
        env: environment(),
        fetchImpl: (url) =>
          String(url).includes("/v1/models/")
            ? Promise.resolve(Response.json({ id: "test-model" }))
            : Promise.resolve(Response.json({ output: [] }))
      }),
      /did not complete the required Responses API tool call/
    );
  });
});
