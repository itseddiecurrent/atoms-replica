export const SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000;
export const RECENT_SIGN_IN_SECONDS = 5 * 60;

export interface DecodedFirebaseToken {
  uid: string;
  email?: string;
  auth_time: number;
}

export interface FirebaseSessionAuth {
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<DecodedFirebaseToken>;
  createSessionCookie(idToken: string, options: { expiresIn: number }): Promise<string>;
  verifySessionCookie(cookie: string, checkRevoked?: boolean): Promise<DecodedFirebaseToken>;
  revokeRefreshTokens(uid: string): Promise<void>;
}

export function getSessionCookieOptions(isProduction: boolean, maxAgeMs = SESSION_DURATION_MS) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000)
  };
}

export async function createVerifiedSession(
  auth: FirebaseSessionAuth,
  idToken: string,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  const decoded = await auth.verifyIdToken(idToken, true);
  if (nowSeconds - decoded.auth_time > RECENT_SIGN_IN_SECONDS) {
    throw new Error("RECENT_SIGN_IN_REQUIRED");
  }

  const sessionCookie = await auth.createSessionCookie(idToken, {
    expiresIn: SESSION_DURATION_MS
  });
  return { decoded, sessionCookie };
}

export async function revokeSession(auth: FirebaseSessionAuth, sessionCookie: string) {
  const decoded = await auth.verifySessionCookie(sessionCookie, false);
  await auth.revokeRefreshTokens(decoded.uid);
}
