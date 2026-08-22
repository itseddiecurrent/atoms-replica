import { cancelRunForUser } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";
import { reportServerError } from "@/lib/server/observability";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
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

  const { runId } = await params;
  if (!z.uuid().safeParse(runId).success)
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid run id."), {
      status: 400
    });

  try {
    const result = await cancelRunForUser(getDatabase(), { runId, userId: user.id });
    if (result === "not_found")
      return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Run not found."), { status: 404 });
    if (result === "terminal")
      return NextResponse.json(
        errorBody(errorCodes.CONFLICT, "Run has already reached a terminal state."),
        { status: 409 }
      );
    return NextResponse.json({ status: "cancelled", runId }, { status: 202 });
  } catch (error) {
    await reportServerError(error, { route: "POST /api/runs/:runId/cancel", runId });
    return NextResponse.json(errorBody(errorCodes.INTERNAL_ERROR, "Unable to cancel run."), {
      status: 500
    });
  }
}
