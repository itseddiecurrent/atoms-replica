import { ActiveRunError, createProjectMessageRun, getProjectForUser } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";
import { reportServerError } from "@/lib/server/observability";
import { enforceUserRunRateLimit, UserRateLimitError } from "@/lib/server/rate-limit";

const bodySchema = z.object({ content: z.string().trim().min(1).max(10_000) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
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
  const { projectId } = await params;
  if (!z.uuid().safeParse(projectId).success)
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid project id."), {
      status: 400
    });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Message cannot be empty."), {
      status: 400
    });
  const database = getDatabase();
  if (!(await getProjectForUser(database, { projectId, userId: user.id })))
    return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Project not found."), {
      status: 404
    });
  try {
    await enforceUserRunRateLimit(database, user.id);
    const result = await createProjectMessageRun(database, {
      projectId,
      userId: user.id,
      content: parsed.data.content
    });
    if (!result)
      return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Project not found."), {
        status: 404
      });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ActiveRunError)
      return NextResponse.json(errorBody(errorCodes.CONFLICT, error.message), { status: 409 });
    if (error instanceof UserRateLimitError)
      return NextResponse.json(errorBody(errorCodes.RATE_LIMITED, error.message), {
        status: 429,
        headers: { "Retry-After": String(error.decision.retryAfterSeconds) }
      });
    await reportServerError(error, {
      route: "POST /api/projects/:projectId/messages",
      projectId,
      userId: user.id
    });
    return NextResponse.json(errorBody(errorCodes.INTERNAL_ERROR, "Unable to queue message."), {
      status: 500
    });
  }
}
