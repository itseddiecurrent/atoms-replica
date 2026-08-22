import { NextResponse } from "next/server";
import { z } from "zod";
import { errorBody, errorCodes } from "@atom-replica/shared";

import { getAdminAuth } from "@/lib/firebase/admin";
import { createVerifiedSession, getSessionCookieOptions } from "@/lib/firebase/session";

export const runtime = "nodejs";

const requestSchema = z.object({ idToken: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const { idToken } = requestSchema.parse(await request.json());
    const { sessionCookie } = await createVerifiedSession(getAdminAuth(), idToken);
    const response = NextResponse.json({ status: "ok" });
    response.cookies.set(
      process.env.SESSION_COOKIE_NAME ?? "atom_demo_session",
      sessionCookie,
      getSessionCookieOptions(process.env.NODE_ENV === "production")
    );
    return response;
  } catch {
    return NextResponse.json(errorBody(errorCodes.AUTH_REQUIRED, "Unable to create a session."), {
      status: 401
    });
  }
}
