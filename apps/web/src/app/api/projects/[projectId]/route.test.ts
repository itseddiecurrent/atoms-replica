import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getDatabase, deleteProjectForUserAndQueueCleanup } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(),
  deleteProjectForUserAndQueueCleanup: vi.fn()
}));

vi.mock("@/lib/server/auth", async () => {
  class AuthenticationRequiredError extends Error {}
  return { AuthenticationRequiredError, requireUser };
});
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ deleteProjectForUserAndQueueCleanup }));

import { AuthenticationRequiredError } from "@/lib/server/auth";
import { DELETE } from "./route";

const projectId = "550e8400-e29b-41d4-a716-446655440000";

describe("DELETE /api/projects/:projectId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
    getDatabase.mockReturnValue("database");
  });

  it("requires authentication", async () => {
    requireUser.mockRejectedValue(new AuthenticationRequiredError());
    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(401);
    expect(deleteProjectForUserAndQueueCleanup).not.toHaveBeenCalled();
  });

  it("does not delete another user's project", async () => {
    deleteProjectForUserAndQueueCleanup.mockResolvedValue(undefined);
    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(404);
    expect(deleteProjectForUserAndQueueCleanup).toHaveBeenCalledWith("database", {
      projectId,
      userId: "user-1"
    });
  });

  it("deletes an owned project", async () => {
    deleteProjectForUserAndQueueCleanup.mockResolvedValue({
      status: "queued",
      cleanupJobId: "cleanup-1"
    });
    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ cleanupJobId: "cleanup-1" });
  });

  it("does not delete a project while its Worker work is active", async () => {
    deleteProjectForUserAndQueueCleanup.mockResolvedValue({ status: "busy" });
    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(409);
  });
});
