import { queueProjectRuntimeJobForUser } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";
import { reportServerError } from "@/lib/server/observability";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return NextResponse.json(errorBody(errorCodes.AUTH_REQUIRED, "Authentication required."), {
        status: 401
      });
    }
    throw error;
  }

  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success) {
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid project id."), {
      status: 400
    });
  }

  const database = getDatabase();
  try {
    const result = await queueProjectRuntimeJobForUser(database, {
      projectId,
      userId: user.id,
      type: "restart_preview"
    });
    if (result.status === "not_found")
      return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Project not found."), {
        status: 404
      });
    if (result.status === "active_run")
      return NextResponse.json(
        errorBody(errorCodes.CONFLICT, "Preview cannot restart while an Agent run is active."),
        { status: 409 }
      );
    if (result.status === "runtime_busy")
      return NextResponse.json(
        errorBody(errorCodes.CONFLICT, "Another Preview operation is still running."),
        { status: 409 }
      );
    return NextResponse.json({ runtimeJobId: result.runtimeJobId }, { status: 202 });
  } catch (error) {
    await reportServerError(error, {
      route: "POST /api/projects/:projectId/runtime/restart",
      projectId
    });
    return NextResponse.json(errorBody(errorCodes.SANDBOX_FAILED, "Preview restart failed."), {
      status: 502
    });
  }
}
