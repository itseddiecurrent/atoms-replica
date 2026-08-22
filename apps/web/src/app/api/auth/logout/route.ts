import { NextResponse } from "next/server";

import { getAdminAuth } from "@/lib/firebase/admin";
import { getSessionCookieOptions, revokeSession } from "@/lib/firebase/session";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  const cookieName = process.env.SESSION_COOKIE_NAME ?? "atom_demo_session";
  const sessionCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`))
    ?.slice(cookieName.length + 1);

  if (sessionCookie) {
    try {
      await revokeSession(getAdminAuth(), decodeURIComponent(sessionCookie));
    } catch {
      // The local cookie must still be removed when it has expired or was revoked.
    }
  }

  const response = NextResponse.json({ status: "ok" });
  response.cookies.set(cookieName, "", {
    ...getSessionCookieOptions(process.env.NODE_ENV === "production", 0),
    expires: new Date(0)
  });
  return response;
}
