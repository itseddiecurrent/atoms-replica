import {
  getProjectFileForUser,
  getProjectForUser,
  updateProjectFileAndQueueSync
} from "@atom-replica/db";
import { errorBody, errorCodes, shouldIncludeProjectFile } from "@atom-replica/shared";
import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";
import { reportServerError } from "@/lib/server/observability";

const updateSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(500_000),
  version: z.number().int().positive()
});

async function authorizedProject(projectId: string) {
  const user = await requireUser();
  const database = getDatabase();
  const project = await getProjectForUser(database, { projectId, userId: user.id });
  return { user, database, project };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    if (!z.uuid().safeParse(projectId).success)
      return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid project id."), {
        status: 400
      });
    const path = new URL(request.url).searchParams.get("path") ?? "";
    if (!shouldIncludeProjectFile(path))
      return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid file path."), {
        status: 400
      });
    const { user, database, project } = await authorizedProject(projectId);
    if (!project)
      return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Project not found."), {
        status: 404
      });
    const file = await getProjectFileForUser(database, { projectId, userId: user.id, path });
    return file
      ? NextResponse.json(file)
      : NextResponse.json(errorBody(errorCodes.NOT_FOUND, "File not found."), { status: 404 });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError)
      return NextResponse.json(errorBody(errorCodes.AUTH_REQUIRED, "Authentication required."), {
        status: 401
      });
    await reportServerError(error, { route: "GET /api/projects/:projectId/files/content" });
    return NextResponse.json(errorBody(errorCodes.INTERNAL_ERROR, "Unable to read file."), {
      status: 500
    });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    if (!z.uuid().safeParse(projectId).success)
      return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid project id."), {
        status: 400
      });
    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !shouldIncludeProjectFile(parsed.data?.path ?? ""))
      return NextResponse.json(errorBody(errorCodes.INVALID_REQUEST, "Invalid file update."), {
        status: 400
      });
    const { user, database, project } = await authorizedProject(projectId);
    if (!project)
      return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "Project not found."), {
        status: 404
      });
    const result = await updateProjectFileAndQueueSync(database, {
      projectId,
      userId: user.id,
      path: parsed.data.path,
      content: parsed.data.content,
      version: parsed.data.version
    });
    if (result.status === "not_found" || result.status === "file_not_found")
      return NextResponse.json(errorBody(errorCodes.NOT_FOUND, "File not found."), { status: 404 });
    if (result.status === "active_run")
      return NextResponse.json(
        errorBody(errorCodes.CONFLICT, "Files cannot be saved while an Agent run is active."),
        { status: 409 }
      );
    if (result.status === "runtime_busy")
      return NextResponse.json(
        errorBody(errorCodes.CONFLICT, "Another Preview operation is still running."),
        { status: 409 }
      );
    if (result.status === "conflict")
      return NextResponse.json(
        { ...errorBody(errorCodes.CONFLICT, "File version conflict."), current: result.current },
        { status: 409 }
      );
    return NextResponse.json({ ...result.file, runtimeJobId: result.runtimeJobId });
  } catch (error) {
    if (error instanceof AuthenticationRequiredError)
      return NextResponse.json(errorBody(errorCodes.AUTH_REQUIRED, "Authentication required."), {
        status: 401
      });
    await reportServerError(error, { route: "PUT /api/projects/:projectId/files/content" });
    return NextResponse.json(errorBody(errorCodes.INTERNAL_ERROR, "Unable to save file."), {
      status: 500
    });
  }
}
