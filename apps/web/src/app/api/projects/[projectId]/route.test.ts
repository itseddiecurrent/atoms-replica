import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getDatabase, getProjectForUser, deleteProject } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(),
  getProjectForUser: vi.fn(),
  deleteProject: vi.fn()
}));

vi.mock("@/lib/server/auth", async () => {
  class AuthenticationRequiredError extends Error {}
  return { AuthenticationRequiredError, requireUser };
});
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ getProjectForUser, deleteProject }));

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
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("does not delete another user's project", async () => {
    getProjectForUser.mockResolvedValue(undefined);
    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(404);
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("deletes an owned project", async () => {
    getProjectForUser.mockResolvedValue({ id: projectId });
    const response = await DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(204);
    expect(deleteProject).toHaveBeenCalledWith("database", projectId);
  });
});
