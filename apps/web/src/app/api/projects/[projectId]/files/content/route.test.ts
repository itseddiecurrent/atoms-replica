import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  getProjectForUser: vi.fn(),
  getProjectFileForUser: vi.fn(),
  updateProjectFileAndQueueSync: vi.fn()
}));
vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser: mocks.requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@atom-replica/db", () => ({
  getProjectForUser: mocks.getProjectForUser,
  getProjectFileForUser: mocks.getProjectFileForUser,
  updateProjectFileAndQueueSync: mocks.updateProjectFileAndQueueSync
}));

import { GET, PUT } from "./route";

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const params = { params: Promise.resolve({ projectId }) };
const putRequest = (path = "src/App.tsx", version = 2) =>
  new Request("http://localhost", {
    method: "PUT",
    body: JSON.stringify({ path, content: "new", version })
  });

describe("project file content API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireUser.mockResolvedValue({ id: "user-1" });
    mocks.getProjectForUser.mockResolvedValue({ id: projectId });
  });

  it("queues durable Worker synchronization with an optimistic file update", async () => {
    mocks.updateProjectFileAndQueueSync.mockResolvedValue({
      status: "queued",
      file: { path: "src/App.tsx", content: "new", version: 3 },
      runtimeJobId: "job-1"
    });
    const response = await PUT(putRequest(), params);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 3, runtimeJobId: "job-1" });
    expect(mocks.updateProjectFileAndQueueSync).toHaveBeenCalledWith("database", {
      projectId,
      userId: "user-1",
      path: "src/App.tsx",
      content: "new",
      version: 2
    });
  });

  it("returns active-run and stale-version conflicts", async () => {
    mocks.updateProjectFileAndQueueSync.mockResolvedValueOnce({ status: "active_run" });
    expect((await PUT(putRequest(), params)).status).toBe(409);
    mocks.updateProjectFileAndQueueSync.mockResolvedValueOnce({
      status: "conflict",
      current: { path: "src/App.tsx", content: "other", version: 3 }
    });
    const response = await PUT(putRequest(), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ current: { version: 3 } });
  });

  it("rejects traversal before reading or writing a project file", async () => {
    const getResponse = await GET(new Request("http://localhost?path=../.env"), params);
    const putResponse = await PUT(putRequest("src/../../.env"), params);
    expect(getResponse.status).toBe(400);
    expect(putResponse.status).toBe(400);
    expect(mocks.getProjectForUser).not.toHaveBeenCalled();
    expect(mocks.updateProjectFileAndQueueSync).not.toHaveBeenCalled();
  });

  it("does not expose another user's file", async () => {
    mocks.getProjectForUser.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost?path=src/App.tsx"), params);
    expect(response.status).toBe(404);
    expect(mocks.getProjectFileForUser).not.toHaveBeenCalled();
  });
});
