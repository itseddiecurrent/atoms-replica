import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, createProjectWithInitialRun, getDatabase, enforceUserRunRateLimit } =
  vi.hoisted(() => ({
    requireUser: vi.fn(),
    createProjectWithInitialRun: vi.fn(),
    getDatabase: vi.fn(),
    enforceUserRunRateLimit: vi.fn()
  }));

vi.mock("@/lib/server/auth", async () => {
  class AuthenticationRequiredError extends Error {}
  return { AuthenticationRequiredError, requireUser };
});
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ createProjectWithInitialRun }));
vi.mock("@/lib/server/observability", () => ({ reportServerError: vi.fn() }));
vi.mock("@/lib/server/rate-limit", () => ({
  enforceUserRunRateLimit,
  UserRateLimitError: class extends Error {
    decision = { retryAfterSeconds: 60 };
  }
}));

import { AuthenticationRequiredError } from "@/lib/server/auth";
import { POST } from "./route";

describe("POST /api/projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDatabase.mockReturnValue("database");
    createProjectWithInitialRun.mockResolvedValue({
      projectId: "project-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      runId: "run-1"
    });
  });

  it("returns 401 when the user is not authenticated", async () => {
    requireUser.mockRejectedValue(new AuthenticationRequiredError());

    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: JSON.stringify({ prompt: "Build a dashboard" }),
        headers: { "Content-Type": "application/json" }
      })
    );

    expect(response.status).toBe(401);
    expect(createProjectWithInitialRun).not.toHaveBeenCalled();
  });

  it("validates the prompt", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });

    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: JSON.stringify({ prompt: "   " }),
        headers: { "Content-Type": "application/json" }
      })
    );

    expect(response.status).toBe(400);
    expect(createProjectWithInitialRun).not.toHaveBeenCalled();
  });

  it("creates an authenticated project and queues its initial run", async () => {
    requireUser.mockResolvedValue({ id: "user-1" });

    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: JSON.stringify({ prompt: "  Build   a water dashboard  " }),
        headers: { "Content-Type": "application/json" }
      })
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      projectId: "project-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      runId: "run-1"
    });
    expect(createProjectWithInitialRun).toHaveBeenCalledWith("database", {
      userId: "user-1",
      name: "Build a water dashboard",
      prompt: "Build   a water dashboard"
    });
    expect(enforceUserRunRateLimit).toHaveBeenCalledWith("database", "user-1");
  });

  it("returns a stable 429 when the user is rate limited", async () => {
    const { UserRateLimitError } = await import("@/lib/server/rate-limit");
    requireUser.mockResolvedValue({ id: "user-1" });
    enforceUserRunRateLimit.mockRejectedValue(
      new UserRateLimitError({
        reason: "daily_runs",
        message: "Too many runs.",
        retryAfterSeconds: 60
      })
    );
    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: JSON.stringify({ prompt: "Build a dashboard" })
      })
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(response.headers.get("retry-after")).toBe("60");
  });
});
