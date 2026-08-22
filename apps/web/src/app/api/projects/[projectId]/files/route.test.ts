import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  getProjectForUser: vi.fn(),
  listProjectFilesForUser: vi.fn()
}));
vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser: mocks.requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@atom-replica/db", () => ({
  getProjectForUser: mocks.getProjectForUser,
  listProjectFilesForUser: mocks.listProjectFilesForUser
}));

import { GET } from "./route";

const projectId = "550e8400-e29b-41d4-a716-446655440000";

describe("GET /api/projects/:projectId/files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("does not list another user's files", async () => {
    mocks.getProjectForUser.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(404);
    expect(mocks.listProjectFilesForUser).not.toHaveBeenCalled();
  });

  it("omits file contents from an owned project listing", async () => {
    mocks.getProjectForUser.mockResolvedValue({ id: projectId });
    mocks.listProjectFilesForUser.mockResolvedValue([
      { path: "src/App.tsx", content: "private source", version: 2, updatedAt: new Date(0) }
    ]);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.files[0]).not.toHaveProperty("content");
  });
});
