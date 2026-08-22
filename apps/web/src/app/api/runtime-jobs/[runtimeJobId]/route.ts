import { getRuntimeJobForUser } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runtimeJobId: string }> }
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
  const { runtimeJobId } = await params;
  if (!z.uuid().safeParse(runtimeJobId).success)
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid runtime job id."), {
      status: 400
    });
  const job = await getRuntimeJobForUser(getDatabase(), { runtimeJobId, userId: user.id });
  if (!job)
    return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Runtime job not found."), {
      status: 404
    });
  return NextResponse.json(job);
}
