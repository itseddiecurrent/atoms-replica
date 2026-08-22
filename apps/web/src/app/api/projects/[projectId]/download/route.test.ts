import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getDatabase, getProjectForUser, listProjectFilesForUser } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  getProjectForUser: vi.fn(),
  listProjectFilesForUser: vi.fn()
}));

vi.mock("@/lib/server/auth", async () => {
  class AuthenticationRequiredError extends Error {}
  return { AuthenticationRequiredError, requireUser };
});
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ getProjectForUser, listProjectFilesForUser }));

import { AuthenticationRequiredError } from "@/lib/server/auth";
import { GET } from "./route";

const projectId = "550e8400-e29b-41d4-a716-446655440000";

describe("GET project download", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("requires authentication", async () => {
    requireUser.mockRejectedValue(new AuthenticationRequiredError());
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });

    expect(response.status).toBe(401);
    expect(listProjectFilesForUser).not.toHaveBeenCalled();
  });

  it("does not expose another user's project", async () => {
    getProjectForUser.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });

    expect(response.status).toBe(404);
    expect(listProjectFilesForUser).not.toHaveBeenCalled();
  });

  it("returns a private ZIP built from the latest project files", async () => {
    getProjectForUser.mockResolvedValue({ id: projectId, name: "Sports Mates" });
    listProjectFilesForUser.mockResolvedValue([
      { path: "src/App.tsx", content: "export default function App() {}" },
      { path: ".env", content: "SECRET=value" }
    ]);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ projectId })
    });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="sports-mates.zip"'
    );
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(bytes)).not.toContain("SECRET=value");
    expect(listProjectFilesForUser).toHaveBeenCalledWith("database", {
      projectId,
      userId: "user-1"
    });
  });
});
