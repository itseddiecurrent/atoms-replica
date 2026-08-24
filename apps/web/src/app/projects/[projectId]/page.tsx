import { notFound, redirect } from "next/navigation";

import {
  getLatestRunForProjectForUser,
  getProjectForUser,
  listMessagesForProjectForUser,
  listProjectFilesForUser
} from "@atom-replica/db";

import { AuthenticationRequiredError, requireUser } from "@/lib/server/auth";
import { getDatabase } from "@/lib/server/database";

import { Workspace } from "./workspace";

export default async function ProjectPage({
  params,
  searchParams
}: {
  params: Promise<{ projectId: string }>;
  searchParams?: Promise<{ run?: string }>;
}) {
  let user;
  try {
    user = await requireUser();
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) redirect("/login");
    throw error;
  }

  const { projectId } = await params;
  const project = await getProjectForUser(getDatabase(), { projectId, userId: user.id });
  if (!project) notFound();

  const requestedRunId = (await searchParams)?.run;

  const messages = await listMessagesForProjectForUser(getDatabase(), {
    projectId: project.id,
    userId: user.id
  });
  const files = await listProjectFilesForUser(getDatabase(), {
    projectId: project.id,
    userId: user.id
  });
  const latestRun = await getLatestRunForProjectForUser(getDatabase(), {
    projectId: project.id,
    userId: user.id
  });
  const latestPlan =
    latestRun?.planJson && typeof latestRun.planJson === "object"
      ? (latestRun.planJson as {
          summary?: unknown;
          steps?: Array<{ title?: unknown }>;
        })
      : undefined;
  const initialPlanSummary =
    typeof latestPlan?.summary === "string" ? latestPlan.summary : undefined;
  const initialPlanSteps = Array.isArray(latestPlan?.steps)
    ? latestPlan.steps
        .map((step) => step.title)
        .filter((title): title is string => typeof title === "string")
    : undefined;

  return (
    <Workspace
      projectId={project.id}
      projectName={project.name}
      initialPreviewUrl={project.previewUrl ?? undefined}
      runId={requestedRunId ?? latestRun?.id}
      initialRunStatus={latestRun?.status}
      initialRunErrorCode={latestRun?.errorCode ?? undefined}
      initialRunErrorMessage={latestRun?.errorMessage ?? undefined}
      initialPlanSummary={initialPlanSummary}
      initialPlanSteps={initialPlanSteps}
      initialFiles={files.map(({ path, version, updatedAt }) => ({ path, version, updatedAt }))}
      messages={messages}
    />
  );
}
