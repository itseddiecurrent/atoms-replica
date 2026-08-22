import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  queueProjectRuntimeJobForUser: vi.fn()
}));
vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser: mocks.requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@atom-replica/db", () => ({
  queueProjectRuntimeJobForUser: mocks.queueProjectRuntimeJobForUser
}));

import { POST } from "./route";

const projectId = "550e8400-e29b-41d4-a716-446655440000";

describe("POST restart preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("queues the operation for the Worker without using E2B in Web", async () => {
    mocks.queueProjectRuntimeJobForUser.mockResolvedValue({
      status: "queued",
      runtimeJobId: "550e8400-e29b-41d4-a716-446655440001"
    });
    const response = await POST(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runtimeJobId: "550e8400-e29b-41d4-a716-446655440001"
    });
  });

  it("hides other users' projects and blocks restarts during an Agent run", async () => {
    mocks.queueProjectRuntimeJobForUser.mockResolvedValueOnce({ status: "not_found" });
    expect(
      (
        await POST(new Request("http://localhost", { method: "POST" }), {
          params: Promise.resolve({ projectId })
        })
      ).status
    ).toBe(404);
    mocks.queueProjectRuntimeJobForUser.mockResolvedValueOnce({ status: "active_run" });
    expect(
      (
        await POST(new Request("http://localhost", { method: "POST" }), {
          params: Promise.resolve({ projectId })
        })
      ).status
    ).toBe(409);
  });
});
