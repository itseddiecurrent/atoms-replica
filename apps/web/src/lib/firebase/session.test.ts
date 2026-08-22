import { describe, expect, it, vi } from "vitest";

import {
  createVerifiedSession,
  getSessionCookieOptions,
  revokeSession,
  SESSION_DURATION_MS,
  type FirebaseSessionAuth
} from "./session";

function createAuth(authTime = 1_000): FirebaseSessionAuth {
  return {
    verifyIdToken: vi.fn().mockResolvedValue({ uid: "user-1", auth_time: authTime }),
    createSessionCookie: vi.fn().mockResolvedValue("session-cookie"),
    verifySessionCookie: vi.fn().mockResolvedValue({ uid: "user-1", auth_time: authTime }),
    revokeRefreshTokens: vi.fn().mockResolvedValue(undefined)
  };
}

describe("Firebase session service", () => {
  it("creates a session for a recent sign-in", async () => {
    const auth = createAuth();
    const result = await createVerifiedSession(auth, "id-token", 1_100);

    expect(result.sessionCookie).toBe("session-cookie");
    expect(auth.createSessionCookie).toHaveBeenCalledWith("id-token", {
      expiresIn: SESSION_DURATION_MS
    });
  });

  it("rejects stale sign-ins", async () => {
    await expect(createVerifiedSession(createAuth(), "id-token", 1_301)).rejects.toThrow(
      "RECENT_SIGN_IN_REQUIRED"
    );
  });

  it("uses secure HttpOnly cookies in production", () => {
    expect(getSessionCookieOptions(true)).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/"
    });
    expect(getSessionCookieOptions(false).secure).toBe(false);
  });

  it("revokes refresh tokens for the session user", async () => {
    const auth = createAuth();
    await revokeSession(auth, "session-cookie");
    expect(auth.revokeRefreshTokens).toHaveBeenCalledWith("user-1");
  });
});
