import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getDatabase, getResourceCleanupJobForUser } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(),
  getResourceCleanupJobForUser: vi.fn()
}));

vi.mock("@/lib/server/auth", async () => {
  class AuthenticationRequiredError extends Error {}
  return { AuthenticationRequiredError, requireUser };
});
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ getResourceCleanupJobForUser }));

import { AuthenticationRequiredError } from "@/lib/server/auth";
import { GET } from "./route";

const cleanupJobId = "550e8400-e29b-41d4-a716-446655440000";

describe("GET /api/resource-cleanups/:cleanupJobId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
    getDatabase.mockReturnValue("database");
  });

  it("requires authentication", async () => {
    requireUser.mockRejectedValue(new AuthenticationRequiredError());
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ cleanupJobId })
    });
    expect(response.status).toBe(401);
  });

  it("does not reveal another user's cleanup", async () => {
    getResourceCleanupJobForUser.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ cleanupJobId })
    });
    expect(response.status).toBe(404);
  });

  it("returns an owned cleanup without resource identifiers", async () => {
    getResourceCleanupJobForUser.mockResolvedValue({
      id: cleanupJobId,
      projectId: "project-1",
      status: "completed"
    });
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ cleanupJobId })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: cleanupJobId,
      projectId: "project-1",
      status: "completed"
    });
  });
});
