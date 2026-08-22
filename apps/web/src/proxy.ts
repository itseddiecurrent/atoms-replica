import { type NextRequest, NextResponse } from "next/server";

import { needsAuthentication } from "@/lib/routing";

export function proxy(request: NextRequest) {
  const cookieName = process.env.SESSION_COOKIE_NAME ?? "atom_demo_session";
  if (needsAuthentication(request.nextUrl.pathname, request.cookies.has(cookieName))) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/projects/:path*"]
};
