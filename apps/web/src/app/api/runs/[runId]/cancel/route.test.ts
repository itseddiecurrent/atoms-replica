import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getDatabase, cancelRunForUser, reportServerError } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  cancelRunForUser: vi.fn(),
  reportServerError: vi.fn()
}));

vi.mock("@/lib/server/auth", () => ({
  AuthenticationRequiredError: class extends Error {},
  requireUser
}));
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@/lib/server/observability", () => ({ reportServerError }));
vi.mock("@atom-replica/db", () => ({ cancelRunForUser }));

import { POST } from "./route";

const runId = "550e8400-e29b-41d4-a716-446655440000";

describe("POST /api/runs/:runId/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
  });

  it("cancels an owned active run", async () => {
    cancelRunForUser.mockResolvedValue("cancelled");
    const response = await POST(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId })
    });
    expect(response.status).toBe(202);
    expect(cancelRunForUser).toHaveBeenCalledWith("database", { runId, userId: "user-1" });
    expect(await response.json()).toEqual({ status: "cancelled", runId });
  });

  it("does not expose another user's run and rejects terminal runs", async () => {
    cancelRunForUser.mockResolvedValueOnce("not_found").mockResolvedValueOnce("terminal");
    const missing = await POST(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId })
    });
    const terminal = await POST(new Request("http://localhost", { method: "POST" }), {
      params: Promise.resolve({ runId })
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
    expect(terminal.status).toBe(409);
    expect(await terminal.json()).toMatchObject({ code: "CONFLICT" });
  });
});
