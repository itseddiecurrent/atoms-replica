import { createProjectWithInitialRun } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getProjectName } from "@/lib/project-name";
import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";
import { reportServerError } from "@/lib/server/observability";
import { enforceUserRunRateLimit, UserRateLimitError } from "@/lib/server/rate-limit";

const createProjectSchema = z.object({
  prompt: z.string().trim().min(1, "Tell us what you want to build.").max(10_000)
});

export const runtime = "nodejs";

export async function POST(request: Request) {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      errorBody(errorCodes.INVALID_REQUEST, "Request body must be valid JSON."),
      { status: 400 }
    );
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      errorBody(
        errorCodes.INVALID_REQUEST,
        parsed.error.issues[0]?.message ?? "Invalid project prompt."
      ),
      { status: 400 }
    );
  }

  const database = getDatabase();
  try {
    await enforceUserRunRateLimit(database, user.id);
    const ids = await createProjectWithInitialRun(database, {
      userId: user.id,
      name: getProjectName(parsed.data.prompt),
      prompt: parsed.data.prompt
    });
    return NextResponse.json(ids, { status: 201 });
  } catch (error) {
    if (error instanceof UserRateLimitError) {
      return NextResponse.json(errorBody(errorCodes.RATE_LIMITED, error.message), {
        status: 429,
        headers: { "Retry-After": String(error.decision.retryAfterSeconds) }
      });
    }
    await reportServerError(error, { route: "POST /api/projects", userId: user.id });
    return NextResponse.json(errorBody(errorCodes.INTERNAL_ERROR, "Unable to create project."), {
      status: 500
    });
  }
}
