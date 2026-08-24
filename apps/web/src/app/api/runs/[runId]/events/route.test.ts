import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireUser, getDatabase, getRunForUser, listRunEventsAfter } = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getDatabase: vi.fn(),
  getRunForUser: vi.fn(),
  listRunEventsAfter: vi.fn()
}));

vi.mock("@/lib/server/auth", async () => {
  class AuthenticationRequiredError extends Error {}
  return { AuthenticationRequiredError, requireUser };
});
vi.mock("@/lib/server/database", () => ({ getDatabase }));
vi.mock("@atom-replica/db", () => ({ getRunForUser, listRunEventsAfter }));

import { GET } from "./route";

describe("GET /api/runs/:runId/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireUser.mockResolvedValue({ id: "user-1" });
    getDatabase.mockReturnValue("database");
    getRunForUser.mockResolvedValue({ run: { id: "550e8400-e29b-41d4-a716-446655440000" } });
  });

  it("rejects an unauthenticated request", async () => {
    const authModule = await import("@/lib/server/auth");
    requireUser.mockRejectedValue(new authModule.AuthenticationRequiredError());
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runId: "550e8400-e29b-41d4-a716-446655440000" })
    });
    expect(response.status).toBe(401);
  });

  it("does not expose another user's event stream", async () => {
    getRunForUser.mockResolvedValue(undefined);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runId: "550e8400-e29b-41d4-a716-446655440000" })
    });
    expect(response.status).toBe(404);
    expect(listRunEventsAfter).not.toHaveBeenCalled();
  });

  it("replays events after Last-Event-ID and closes on completion", async () => {
    listRunEventsAfter.mockResolvedValue([
      {
        id: 8,
        type: "run.completed",
        payloadJson: { summary: "Done" },
        createdAt: new Date("2026-08-22T00:00:00.000Z")
      }
    ]);
    const response = await GET(
      new Request("http://localhost", { headers: { "Last-Event-ID": "7" } }),
      { params: Promise.resolve({ runId: "550e8400-e29b-41d4-a716-446655440000" }) }
    );

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(listRunEventsAfter).toHaveBeenCalledWith(
      "database",
      "550e8400-e29b-41d4-a716-446655440000",
      7
    );
    const body = await response.text();
    expect(body).toContain("id: 8");
    expect(body).toContain("event: run.completed");
  });

  it("treats cancellation as a terminal SSE event", async () => {
    listRunEventsAfter.mockResolvedValue([
      {
        id: 9,
        type: "run.cancelled",
        payloadJson: { code: "RUN_CANCELLED", message: "Run cancelled by user." },
        createdAt: new Date("2026-08-22T00:00:00.000Z")
      }
    ]);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runId: "550e8400-e29b-41d4-a716-446655440000" })
    });
    expect(await response.text()).toContain("event: run.cancelled");
  });

  it("stops database polling when the client disconnects", async () => {
    vi.useFakeTimers();
    getRunForUser.mockResolvedValue({ run: { status: "planning" } });
    listRunEventsAfter.mockResolvedValue([]);
    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ runId: "550e8400-e29b-41d4-a716-446655440000" })
    });
    await response.body?.cancel();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listRunEventsAfter).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
