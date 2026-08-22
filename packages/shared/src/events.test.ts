import { describe, expect, it } from "vitest";

import { runEventSchema } from "./events";

describe("runEventSchema", () => {
  it("parses a completed event", () => {
    const event = runEventSchema.parse({
      eventId: 1,
      runId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-08-22T00:00:00.000Z",
      type: "run.completed",
      payload: { summary: "Done" }
    });

    expect(event.type).toBe("run.completed");
  });

  it("rejects a malformed event", () => {
    expect(() => runEventSchema.parse({ type: "run.completed" })).toThrow();
  });

  it("parses progress events used by the activity stream", () => {
    const event = runEventSchema.parse({
      eventId: 2,
      runId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-08-22T00:00:00.000Z",
      type: "step.started",
      payload: { step: "step-1", title: "Prepare project files" }
    });

    expect(event.type).toBe("step.started");
  });

  it("parses validation failures with their repair attempt", () => {
    const event = runEventSchema.parse({
      eventId: 3,
      runId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-08-22T00:00:00.000Z",
      type: "validation.failed",
      payload: { message: "pnpm build failed", attempt: 1 }
    });

    expect(event.type).toBe("validation.failed");
  });

  it("parses cancellation as a terminal run event", () => {
    const event = runEventSchema.parse({
      eventId: 4,
      runId: "550e8400-e29b-41d4-a716-446655440000",
      timestamp: "2026-08-22T00:00:00.000Z",
      type: "run.cancelled",
      payload: { message: "Run cancelled by user." }
    });
    expect(event.type).toBe("run.cancelled");
  });
});
