import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireUser,
  getDatabase,
  getProjectForUser,
  createProjectMessageRun,
  ActiveRunError,
  enforceUserRunRateLimit
} = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  getProjectForUser: vi.fn(),
  createProjectMessageRun: vi.fn(),
  ActiveRunError: class ActiveRunError extends Error {},
  enforceUserRunRateLimit: vi.fn()
}));
vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ ActiveRunError, getProjectForUser, createProjectMessageRun }));
vi.mock("@/lib/server/observability", () => ({ reportServerError: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({
  enforceUserRunRateLimit,
  UserRateLimitError: class extends Error {
    decision = { retryAfterSeconds: 5 };
  }
}));

import { POST } from "./route";
const projectId = "550e8400-e29b-41d4-a716-446655440000";

describe("POST project messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
    getProjectForUser.mockResolvedValue({ id: projectId });
  });

  it("queues a trimmed follow-up message", async () => {
    createProjectMessageRun.mockResolvedValue({ messageId: "message-2", runId: "run-2" });
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ content: "  Make it blue  " })
      }),
      { params: Promise.resolve({ projectId }) }
    );
    expect(response.status).toBe(201);
    expect(createProjectMessageRun).toHaveBeenCalledWith("database", {
      projectId,
      userId: "user-1",
      content: "Make it blue"
    });
    expect(enforceUserRunRateLimit).toHaveBeenCalledWith("database", "user-1");
  });

  it("rejects empty messages and concurrent runs", async () => {
    const empty = await POST(
      new Request("http://localhost", { method: "POST", body: JSON.stringify({ content: " " }) }),
      { params: Promise.resolve({ projectId }) }
    );
    expect(empty.status).toBe(400);
    createProjectMessageRun.mockRejectedValue(new ActiveRunError());
    const active = await POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ content: "Change it" })
      }),
      { params: Promise.resolve({ projectId }) }
    );
    expect(active.status).toBe(409);
  });

  it("does not queue a message for another user's project", async () => {
    getProjectForUser.mockResolvedValue(undefined);
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ content: "Change the app" })
      }),
      { params: Promise.resolve({ projectId }) }
    );
    expect(response.status).toBe(404);
    expect(createProjectMessageRun).not.toHaveBeenCalled();
  });

  it("returns RATE_LIMITED without creating a message", async () => {
    const { UserRateLimitError } = await import("@/lib/server/rate-limit");
    enforceUserRunRateLimit.mockRejectedValue(
      new UserRateLimitError({
        reason: "concurrent_runs",
        message: "An active run exists.",
        retryAfterSeconds: 5
      })
    );
    const response = await POST(
      new Request("http://localhost", {
        method: "POST",
        body: JSON.stringify({ content: "Change it" })
      }),
      { params: Promise.resolve({ projectId }) }
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(createProjectMessageRun).not.toHaveBeenCalled();
  });
});
