import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  getProjectPersistenceEvidenceForUser: vi.fn()
}));
vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser: mocks.requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@atom-replica/db", () => ({
  getProjectPersistenceEvidenceForUser: mocks.getProjectPersistenceEvidenceForUser
}));

import { GET } from "./route";

const projectId = "550e8400-e29b-41d4-a716-446655440000";

describe("GET /api/projects/:projectId/persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("returns only owner-scoped persistence metadata", async () => {
    mocks.getProjectPersistenceEvidenceForUser.mockResolvedValue({
      project: { id: projectId, latestSnapshotId: "snapshot-2" },
      messages: [{ id: "message-1", role: "user", runId: "run-1" }],
      runs: [{ id: "run-1", status: "completed", hasPlan: true }],
      files: [{ path: "src/App.tsx", version: 2 }],
      snapshots: [{ id: "snapshot-2", runId: "run-1" }],
      runtimeJobs: []
    });
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body.files).toEqual([{ path: "src/App.tsx", version: 2 }]);
    expect(JSON.stringify(body)).not.toContain("source");
    expect(mocks.getProjectPersistenceEvidenceForUser).toHaveBeenCalledWith("database", {
      projectId,
      userId: "user-1"
    });
  });

  it("does not reveal another user's persistence metadata", async () => {
    mocks.getProjectPersistenceEvidenceForUser.mockResolvedValue(null);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    expect(response.status).toBe(404);
  });
});
