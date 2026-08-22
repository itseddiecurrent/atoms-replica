import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  getRuntimeJobForUser: vi.fn()
}));
vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser: mocks.requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@atom-replica/db", () => ({ getRuntimeJobForUser: mocks.getRuntimeJobForUser }));

import { GET } from "./route";

const runtimeJobId = "550e8400-e29b-41d4-a716-446655440000";

describe("GET /api/runtime-jobs/:runtimeJobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("returns an owned runtime job", async () => {
    mocks.getRuntimeJobForUser.mockResolvedValue({ id: runtimeJobId, status: "completed" });
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runtimeJobId })
    });
    expect(response.status).toBe(200);
    expect(mocks.getRuntimeJobForUser).toHaveBeenCalledWith("database", {
      runtimeJobId,
      userId: "user-1"
    });
  });

  it("does not reveal another user's runtime job", async () => {
    mocks.getRuntimeJobForUser.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runtimeJobId })
    });
    expect(response.status).toBe(404);
  });

  it("requires authentication", async () => {
    const auth = await import("@/lib/server/auth");
    mocks.requireUser.mockRejectedValue(new auth.AuthenticationRequiredError());
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runtimeJobId })
    });
    expect(response.status).toBe(401);
    expect(mocks.getRuntimeJobForUser).not.toHaveBeenCalled();
  });
});
