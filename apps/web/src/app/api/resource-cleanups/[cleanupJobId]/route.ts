import { getResourceCleanupJobForUser } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ cleanupJobId: string }> }
) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError)
      return NextResponse.json(errorBody(errorCodes.AUTH_REQUIRED, "Authentication required."), {
        status: 401
      });
    throw error;
  }
  const { cleanupJobId } = await params;
  if (!z.uuid().safeParse(cleanupJobId).success)
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid cleanup job id."), {
      status: 400
    });
  const job = await getResourceCleanupJobForUser(getDatabase(), {
    cleanupJobId,
    userId: user.id
  });
  if (!job)
    return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Cleanup job not found."), {
      status: 404
    });
  return NextResponse.json(job, { headers: { "Cache-Control": "private, no-store" } });
}
