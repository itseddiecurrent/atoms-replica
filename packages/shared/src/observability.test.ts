import { describe, expect, it, vi } from "vitest";

import { captureException, errorBody, logProviderCall, observeProviderCall } from "./observability";

describe("observability helpers", () => {
  it("returns stable API error bodies", () => {
    expect(errorBody("RATE_LIMITED", "Slow down.")).toEqual({
      code: "RATE_LIMITED",
      error: "Slow down."
    });
  });

  it("logs provider metadata without request inputs", async () => {
    const calls: unknown[] = [];
    await expect(
      observeProviderCall(
        { provider: "supabase", operation: "storage.upload" },
        async () => "ok",
        (call) => calls.push(call)
      )
    ).resolves.toBe("ok");
    expect(calls).toEqual([
      expect.objectContaining({
        provider: "supabase",
        operation: "storage.upload",
        status: "ok",
        durationMs: expect.any(Number)
      })
    ]);
    expect(JSON.stringify(calls)).not.toContain("secret");
  });

  it("is disabled without a Sentry DSN and sends an envelope when configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await expect(captureException(new Error("boom"), { fetchImpl })).resolves.toBe(false);
    await expect(
      captureException(new Error("boom"), {
        dsn: "https://public@example.sentry.io/123",
        fetchImpl,
        context: { runId: "run-1" }
      })
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.sentry.io/api/123/envelope/",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("serializes provider logs as one structured record", () => {
    const logger = vi.fn();
    logProviderCall(
      { provider: "openai", operation: "responses.plan", durationMs: 12, status: "ok" },
      logger
    );
    expect(JSON.parse(logger.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider.call",
      provider: "openai"
    });
  });
});
