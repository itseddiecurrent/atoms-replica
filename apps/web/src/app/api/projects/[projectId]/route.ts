import { deleteProject, getProjectForUser } from "@atom-replica/db";
import { errorBody, errorCodes } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";

export const runtime = "nodejs";

export async function DELETE(
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
  const project = await getProjectForUser(database, { projectId, userId: user.id });
  if (!project)
    return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Project not found."), {
      status: 404
    });

  await deleteProject(database, projectId);
  return new Response(null, { status: 204 });
}
