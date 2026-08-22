import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkDatabaseHealth: vi.fn(),
  getDatabase: vi.fn(() => "database"),
  parseServerEnv: vi.fn()
}));

vi.mock("@atom-replica/db", () => ({ checkDatabaseHealth: mocks.checkDatabaseHealth }));
vi.mock("@/lib/server/database", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("@atom-replica/shared/env", () => ({ parseServerEnv: mocks.parseServerEnv }));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns readiness only after a database query succeeds", async () => {
    mocks.checkDatabaseHealth.mockResolvedValue(undefined);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", database: "ok" });
    expect(mocks.checkDatabaseHealth).toHaveBeenCalledWith("database");
    expect(mocks.parseServerEnv).toHaveBeenCalled();
  });

  it("returns 503 when required production configuration is missing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.parseServerEnv.mockImplementationOnce(() => {
      throw new Error("Missing FIREBASE_ADMIN_PRIVATE_KEY");
    });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(mocks.checkDatabaseHealth).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns 503 without exposing database errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.checkDatabaseHealth.mockRejectedValue(
      new Error("postgresql://user:secret@private.example/database")
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    consoleError.mockRestore();
  });
});
