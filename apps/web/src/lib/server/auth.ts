import { upsertUser } from "@atom-replica/db";
import { cookies } from "next/headers";

import { getAdminAuth } from "@/lib/firebase/admin";
import { getDatabase } from "@/lib/server/database";

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Authentication is required.");
    this.name = "AuthenticationRequiredError";
  }
}

export async function requireUser() {
  const cookieStore = await cookies();
  const cookieName = process.env.SESSION_COOKIE_NAME ?? "atom_demo_session";
  const sessionCookie = cookieStore.get(cookieName)?.value;
  if (!sessionCookie) throw new AuthenticationRequiredError();

  try {
    const decoded = await getAdminAuth().verifySessionCookie(sessionCookie, true);
    if (!decoded.email) throw new AuthenticationRequiredError();

    return await upsertUser(getDatabase(), { id: decoded.uid, email: decoded.email });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) throw error;
    throw new AuthenticationRequiredError();
  }
}

export function assertResourceOwner(currentUserId: string, resourceUserId: string) {
  if (currentUserId !== resourceUserId) throw new AuthenticationRequiredError();
}
