import { and, asc, desc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import type { Database } from "./client.js";
import {
  conversations,
  messages,
  projectFiles,
  projects,
  runtimeJobs,
  runEvents,
  runs,
  snapshots,
  users,
  type ProjectFile
} from "./schema.js";

export type ClaimedRun = {
  id: string;
  projectId: string;
  triggerMessageId: string;
  status: "planning";
};

export type ClaimedRuntimeJob = {
  id: string;
  projectId: string;
  type: "sync_file" | "restart_preview";
  payloadJson: unknown;
};

const activeRunStatuses = ["queued", "planning", "coding", "validating"] as const;
const activeRuntimeJobStatuses = ["queued", "processing"] as const;

export class ActiveRunError extends Error {
  constructor() {
    super("This project already has an active run.");
  }
}

export async function upsertUser(db: Database, input: { id: string; email: string }) {
  const [user] = await db
    .insert(users)
    .values(input)
    .onConflictDoUpdate({ target: users.id, set: { email: input.email } })
    .returning();

  if (!user) throw new Error("Failed to upsert user.");
  return user;
}

export async function checkDatabaseHealth(db: Database) {
  await db.execute(sql`select 1 as ok`);
}

export async function createProjectWithInitialRun(
  db: Database,
  input: { userId: string; name: string; prompt: string }
) {
  const ids = {
    projectId: randomUUID(),
    conversationId: randomUUID(),
    messageId: randomUUID(),
    runId: randomUUID()
  };

  await db.transaction(async (tx) => {
    await tx.insert(projects).values({
      id: ids.projectId,
      userId: input.userId,
      name: input.name,
      status: "queued"
    });
    await tx.insert(conversations).values({ id: ids.conversationId, projectId: ids.projectId });
    await tx.insert(messages).values({
      id: ids.messageId,
      conversationId: ids.conversationId,
      role: "user",
      content: input.prompt,
      runId: ids.runId
    });
    await tx.insert(runs).values({
      id: ids.runId,
      projectId: ids.projectId,
      triggerMessageId: ids.messageId,
      status: "queued"
    });
    await tx.insert(runEvents).values({
      runId: ids.runId,
      type: "run.queued",
      payloadJson: {}
    });
  });

  return ids;
}

export async function getProjectForUser(
  db: Database,
  input: { projectId: string; userId: string }
) {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)))
    .limit(1);

  return project;
}

export async function listProjectsForUser(db: Database, userId: string) {
  const rows = await db
    .select({ project: projects, run: runs })
    .from(projects)
    .leftJoin(runs, eq(runs.projectId, projects.id))
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt), desc(runs.createdAt));
  const latestByProject = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByProject.has(row.project.id)) latestByProject.set(row.project.id, row);
  }
  return [...latestByProject.values()].map(({ project, run }) => ({
    ...project,
    latestRunStatus: run?.status ?? null
  }));
}

export async function listMessagesForProjectForUser(
  db: Database,
  input: { projectId: string; userId: string }
) {
  const rows = await db
    .select({ message: messages })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(projects, eq(conversations.projectId, projects.id))
    .where(and(eq(conversations.projectId, input.projectId), eq(projects.userId, input.userId)))
    .orderBy(asc(messages.createdAt));

  return rows.map(({ message }) => message);
}

export async function listProjectFilesForUser(
  db: Database,
  input: { projectId: string; userId: string }
) {
  return db
    .select({
      path: projectFiles.path,
      content: projectFiles.content,
      version: projectFiles.version,
      updatedAt: projectFiles.updatedAt
    })
    .from(projectFiles)
    .innerJoin(projects, eq(projectFiles.projectId, projects.id))
    .where(and(eq(projectFiles.projectId, input.projectId), eq(projects.userId, input.userId)))
    .orderBy(asc(projectFiles.path));
}

export async function listProjectFiles(db: Database, projectId: string) {
  return db
    .select({
      path: projectFiles.path,
      content: projectFiles.content,
      version: projectFiles.version
    })
    .from(projectFiles)
    .where(eq(projectFiles.projectId, projectId))
    .orderBy(asc(projectFiles.path));
}

export async function getProjectFileForUser(
  db: Database,
  input: { projectId: string; userId: string; path: string }
) {
  const [file] = await db
    .select({
      path: projectFiles.path,
      content: projectFiles.content,
      version: projectFiles.version,
      updatedAt: projectFiles.updatedAt
    })
    .from(projectFiles)
    .innerJoin(projects, eq(projectFiles.projectId, projects.id))
    .where(
      and(
        eq(projectFiles.projectId, input.projectId),
        eq(projectFiles.path, input.path),
        eq(projects.userId, input.userId)
      )
    )
    .limit(1);
  return file;
}

export async function getProjectRuntimeState(db: Database, projectId: string) {
  const [row] = await db
    .select({ project: projects, snapshot: snapshots })
    .from(projects)
    .leftJoin(snapshots, eq(projects.latestSnapshotId, snapshots.id))
    .where(eq(projects.id, projectId))
    .limit(1);
  return row;
}

export async function getLatestRunForProjectForUser(
  db: Database,
  input: { projectId: string; userId: string }
) {
  const [run] = await db
    .select({
      id: runs.id,
      status: runs.status,
      errorCode: runs.errorCode,
      errorMessage: runs.errorMessage
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.projectId, input.projectId), eq(projects.userId, input.userId)))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return run;
}

export async function getProjectAgentContext(db: Database, projectId: string) {
  const [files, conversationMessages] = await Promise.all([
    listProjectFiles(db, projectId),
    db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(eq(conversations.projectId, projectId))
      .orderBy(desc(messages.createdAt))
      .limit(10)
  ]);
  return { files, messages: conversationMessages.reverse() };
}

export async function getUserRateUsage(db: Database, userId: string, now = new Date()) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const minuteStart = new Date(now.getTime() - 60_000);
  const [daily, recent, active] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .innerJoin(projects, eq(runs.projectId, projects.id))
      .where(and(eq(projects.userId, userId), gte(runs.createdAt, dayStart))),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .innerJoin(projects, eq(conversations.projectId, projects.id))
      .where(
        and(
          eq(projects.userId, userId),
          eq(messages.role, "user"),
          gte(messages.createdAt, minuteStart)
        )
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .innerJoin(projects, eq(runs.projectId, projects.id))
      .where(and(eq(projects.userId, userId), inArray(runs.status, activeRunStatuses)))
  ]);
  return {
    dailyRuns: daily[0]?.count ?? 0,
    recentMessages: recent[0]?.count ?? 0,
    activeRuns: active[0]?.count ?? 0
  };
}

export async function recordRunUsage(
  db: Database,
  input: {
    runId: string;
    modelTokens: number;
    sandboxDurationSeconds: number;
    attemptCount: number;
  }
) {
  await db
    .update(runs)
    .set({
      modelTokens: input.modelTokens,
      sandboxDurationSeconds: input.sandboxDurationSeconds,
      attemptCount: input.attemptCount
    })
    .where(eq(runs.id, input.runId));
}

export async function isRunCancelled(db: Database, runId: string) {
  const [run] = await db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return run?.status === "cancelled";
}

export async function cancelRunForUser(db: Database, input: { runId: string; userId: string }) {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ run: runs, project: projects })
      .from(runs)
      .innerJoin(projects, eq(runs.projectId, projects.id))
      .where(and(eq(runs.id, input.runId), eq(projects.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!owned) return "not_found" as const;
    if (!activeRunStatuses.includes(owned.run.status as (typeof activeRunStatuses)[number]))
      return "terminal" as const;
    await tx
      .update(runs)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(runs.id, input.runId));
    await tx
      .update(projects)
      .set({ status: owned.project.previewUrl ? "running" : "failed", updatedAt: new Date() })
      .where(eq(projects.id, owned.project.id));
    await tx.insert(runEvents).values({
      runId: input.runId,
      type: "run.cancelled",
      payloadJson: { message: "Run cancelled by user." }
    });
    return "cancelled" as const;
  });
}

export async function createProjectMessageRun(
  db: Database,
  input: { projectId: string; userId: string; content: string }
) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!project) return null;
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, input.projectId), inArray(runs.status, activeRunStatuses)))
      .limit(1);
    if (active) throw new ActiveRunError();
    const [activeRuntimeJob] = await tx
      .select({ id: runtimeJobs.id })
      .from(runtimeJobs)
      .where(
        and(
          eq(runtimeJobs.projectId, input.projectId),
          inArray(runtimeJobs.status, activeRuntimeJobStatuses)
        )
      )
      .limit(1);
    if (activeRuntimeJob) throw new ActiveRunError();
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.projectId, input.projectId))
      .orderBy(asc(conversations.createdAt))
      .limit(1);
    if (!conversation) throw new Error("Project conversation was not found.");
    const messageId = randomUUID();
    const runId = randomUUID();
    await tx.insert(messages).values({
      id: messageId,
      conversationId: conversation.id,
      role: "user",
      content: input.content,
      runId
    });
    await tx.insert(runs).values({
      id: runId,
      projectId: input.projectId,
      triggerMessageId: messageId,
      status: "queued"
    });
    await tx.insert(runEvents).values({ runId, type: "run.queued", payloadJson: {} });
    await tx
      .update(projects)
      .set({ status: "queued", updatedAt: new Date() })
      .where(eq(projects.id, input.projectId));
    return { messageId, runId };
  });
}

export async function updateProjectFileAndQueueSync(
  db: Database,
  input: { projectId: string; userId: string; path: string; content: string; version: number }
) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!project) return { status: "not_found" as const };

    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, input.projectId), inArray(runs.status, activeRunStatuses)))
      .limit(1);
    if (active) return { status: "active_run" as const };
    const [activeRuntimeJob] = await tx
      .select({ id: runtimeJobs.id })
      .from(runtimeJobs)
      .where(
        and(
          eq(runtimeJobs.projectId, input.projectId),
          inArray(runtimeJobs.status, activeRuntimeJobStatuses)
        )
      )
      .limit(1);
    if (activeRuntimeJob) return { status: "runtime_busy" as const };

    const [current] = await tx
      .select({
        path: projectFiles.path,
        content: projectFiles.content,
        version: projectFiles.version,
        updatedAt: projectFiles.updatedAt
      })
      .from(projectFiles)
      .where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, input.path)))
      .limit(1);
    if (!current) return { status: "file_not_found" as const };
    if (current.version !== input.version) return { status: "conflict" as const, current };

    const contentHash = createHash("sha256").update(input.content).digest("hex");
    const [file] = await tx
      .update(projectFiles)
      .set({
        content: input.content,
        contentHash,
        updatedBy: "user",
        updatedAt: new Date(),
        version: sql`${projectFiles.version} + 1`
      })
      .where(
        and(
          eq(projectFiles.projectId, input.projectId),
          eq(projectFiles.path, input.path),
          eq(projectFiles.version, input.version)
        )
      )
      .returning();
    if (!file) {
      const [latest] = await tx
        .select({
          path: projectFiles.path,
          content: projectFiles.content,
          version: projectFiles.version,
          updatedAt: projectFiles.updatedAt
        })
        .from(projectFiles)
        .where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, input.path)))
        .limit(1);
      return { status: "conflict" as const, current: latest };
    }

    const [job] = await tx
      .insert(runtimeJobs)
      .values({
        projectId: input.projectId,
        type: "sync_file",
        payloadJson: { path: input.path, version: file.version }
      })
      .returning({ id: runtimeJobs.id });
    if (!job) throw new Error("Failed to queue file synchronization.");
    return { status: "queued" as const, file, runtimeJobId: job.id };
  });
}

export async function queueProjectRuntimeJobForUser(
  db: Database,
  input: { projectId: string; userId: string; type: "restart_preview" }
) {
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.userId, input.userId)))
      .limit(1)
      .for("update");
    if (!project) return { status: "not_found" as const };
    const [active] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.projectId, input.projectId), inArray(runs.status, activeRunStatuses)))
      .limit(1);
    if (active) return { status: "active_run" as const };
    const [activeRuntimeJob] = await tx
      .select({ id: runtimeJobs.id })
      .from(runtimeJobs)
      .where(
        and(
          eq(runtimeJobs.projectId, input.projectId),
          inArray(runtimeJobs.status, activeRuntimeJobStatuses)
        )
      )
      .limit(1);
    if (activeRuntimeJob) return { status: "runtime_busy" as const };
    const [job] = await tx
      .insert(runtimeJobs)
      .values({ projectId: input.projectId, type: input.type, payloadJson: {} })
      .returning({ id: runtimeJobs.id });
    if (!job) throw new Error("Failed to queue runtime operation.");
    return { status: "queued" as const, runtimeJobId: job.id };
  });
}

export async function getRuntimeJobForUser(
  db: Database,
  input: { runtimeJobId: string; userId: string }
) {
  const [job] = await db
    .select({
      id: runtimeJobs.id,
      projectId: runtimeJobs.projectId,
      type: runtimeJobs.type,
      status: runtimeJobs.status,
      resultJson: runtimeJobs.resultJson,
      errorMessage: runtimeJobs.errorMessage,
      createdAt: runtimeJobs.createdAt,
      finishedAt: runtimeJobs.finishedAt
    })
    .from(runtimeJobs)
    .innerJoin(projects, eq(runtimeJobs.projectId, projects.id))
    .where(and(eq(runtimeJobs.id, input.runtimeJobId), eq(projects.userId, input.userId)))
    .limit(1);
  return job;
}

export async function claimNextRuntimeJob(
  db: Database,
  workerId: string
): Promise<ClaimedRuntimeJob | null> {
  return db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(runtimeJobs)
      .where(and(eq(runtimeJobs.status, "queued"), lte(runtimeJobs.availableAt, new Date())))
      .orderBy(asc(runtimeJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!job) return null;
    const [claimed] = await tx
      .update(runtimeJobs)
      .set({ status: "processing", workerId, heartbeatAt: new Date(), startedAt: new Date() })
      .where(and(eq(runtimeJobs.id, job.id), eq(runtimeJobs.status, "queued")))
      .returning({
        id: runtimeJobs.id,
        projectId: runtimeJobs.projectId,
        type: runtimeJobs.type,
        payloadJson: runtimeJobs.payloadJson
      });
    return claimed ?? null;
  });
}

export async function heartbeatRuntimeJob(db: Database, runtimeJobId: string, workerId: string) {
  await db
    .update(runtimeJobs)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(runtimeJobs.id, runtimeJobId), eq(runtimeJobs.workerId, workerId)));
}

export async function completeRuntimeJob(
  db: Database,
  input: { runtimeJobId: string; workerId: string; result: Record<string, unknown> }
) {
  await db
    .update(runtimeJobs)
    .set({
      status: "completed",
      resultJson: input.result,
      errorMessage: null,
      heartbeatAt: new Date(),
      finishedAt: new Date()
    })
    .where(and(eq(runtimeJobs.id, input.runtimeJobId), eq(runtimeJobs.workerId, input.workerId)));
}

export async function failRuntimeJob(
  db: Database,
  input: { runtimeJobId: string; workerId: string; message: string }
) {
  await db
    .update(runtimeJobs)
    .set({ status: "failed", errorMessage: input.message, finishedAt: new Date() })
    .where(and(eq(runtimeJobs.id, input.runtimeJobId), eq(runtimeJobs.workerId, input.workerId)));
}

export async function recoverStaleRuntimeJobs(db: Database, staleBefore: Date) {
  const recovered = await db
    .update(runtimeJobs)
    .set({
      status: "queued",
      workerId: null,
      heartbeatAt: null,
      startedAt: null,
      availableAt: new Date()
    })
    .where(and(eq(runtimeJobs.status, "processing"), lt(runtimeJobs.heartbeatAt, staleBefore)))
    .returning({ id: runtimeJobs.id });
  return recovered.length;
}

export async function appendRunEvent(
  db: Database,
  input: { runId: string; type: string; payload: Record<string, unknown> }
) {
  const [event] = await db
    .insert(runEvents)
    .values({ runId: input.runId, type: input.type, payloadJson: input.payload })
    .returning();

  if (!event) throw new Error("Failed to append run event.");
  return event;
}

export async function getMessageContent(db: Database, messageId: string) {
  const [message] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return message?.content;
}

export async function saveRunPlan(db: Database, runId: string, plan: unknown) {
  await db.update(runs).set({ planJson: plan }).where(eq(runs.id, runId));
}

export async function listRunEventsAfter(db: Database, runId: string, afterEventId = 0) {
  return db
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.id, afterEventId)))
    .orderBy(asc(runEvents.id));
}

export async function getRunForUser(db: Database, input: { runId: string; userId: string }) {
  const [run] = await db
    .select({ run: runs, project: projects })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(and(eq(runs.id, input.runId), eq(projects.userId, input.userId)))
    .limit(1);

  return run;
}

export async function claimNextRun(db: Database, workerId: string): Promise<ClaimedRun | null> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(and(eq(runs.status, "queued"), lte(runs.availableAt, new Date())))
      .orderBy(asc(runs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!run) return null;

    const [claimed] = await tx
      .update(runs)
      .set({ status: "planning", workerId, heartbeatAt: new Date(), startedAt: new Date() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "queued")))
      .returning({
        id: runs.id,
        projectId: runs.projectId,
        triggerMessageId: runs.triggerMessageId
      });

    if (!claimed) return null;

    await tx
      .update(projects)
      .set({ status: "planning", updatedAt: new Date() })
      .where(eq(projects.id, claimed.projectId));

    return { ...claimed, status: "planning" as const };
  });
}

export async function heartbeatRun(db: Database, runId: string, workerId: string) {
  await db
    .update(runs)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.workerId, workerId)));
}

export async function beginRunCoding(db: Database, runId: string, workerId: string) {
  await db
    .update(runs)
    .set({ status: "coding", heartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.workerId, workerId)));
}

export async function beginRunValidation(db: Database, runId: string, workerId: string) {
  await db
    .update(runs)
    .set({ status: "validating", heartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.workerId, workerId)));
}

export async function completeRun(
  db: Database,
  input: { runId: string; projectId: string; workerId: string }
) {
  await db.transaction(async (tx) => {
    await tx
      .update(runs)
      .set({ status: "completed", heartbeatAt: new Date(), finishedAt: new Date() })
      .where(and(eq(runs.id, input.runId), eq(runs.workerId, input.workerId)));
    await tx
      .update(projects)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(projects.id, input.projectId));
  });
}

export async function failRun(
  db: Database,
  input: { runId: string; projectId: string; workerId: string; code: string; message: string }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [failed] = await tx
      .update(runs)
      .set({
        status: "failed",
        errorCode: input.code,
        errorMessage: input.message,
        finishedAt: new Date()
      })
      .where(
        and(
          eq(runs.id, input.runId),
          eq(runs.workerId, input.workerId),
          inArray(runs.status, ["planning", "coding", "validating"])
        )
      )
      .returning({ id: runs.id });
    if (failed) {
      const [project] = await tx
        .select({ previewUrl: projects.previewUrl })
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .limit(1);
      await tx
        .update(projects)
        .set({ status: project?.previewUrl ? "running" : "failed", updatedAt: new Date() })
        .where(eq(projects.id, input.projectId));
    }
    return Boolean(failed);
  });
}

export async function recoverStaleRuns(db: Database, staleBefore: Date) {
  return db.transaction(async (tx) => {
    const staleRuns = await tx
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, ["planning", "coding", "validating"]),
          lt(runs.heartbeatAt, staleBefore)
        )
      )
      .for("update", { skipLocked: true });

    for (const run of staleRuns) {
      await tx
        .update(runs)
        .set({
          status: "failed",
          errorCode: "RUN_TIMEOUT",
          errorMessage: "Worker heartbeat expired.",
          finishedAt: new Date()
        })
        .where(eq(runs.id, run.id));
      await tx
        .update(projects)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(projects.id, run.projectId));
      await tx.insert(runEvents).values({
        runId: run.id,
        type: "run.failed",
        payloadJson: { code: "RUN_TIMEOUT", message: "Worker heartbeat expired." }
      });
    }

    return staleRuns.length;
  });
}

export async function upsertProjectFile(
  db: Database,
  input: {
    projectId: string;
    path: string;
    content: string;
    updatedBy: "agent" | "user";
  }
): Promise<ProjectFile> {
  const contentHash = createHash("sha256").update(input.content).digest("hex");
  const [file] = await db
    .insert(projectFiles)
    .values({ ...input, contentHash })
    .onConflictDoUpdate({
      target: [projectFiles.projectId, projectFiles.path],
      set: {
        content: input.content,
        contentHash,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
        version: sql`${projectFiles.version} + 1`
      }
    })
    .returning();

  if (!file) throw new Error("Failed to upsert project file.");
  return file;
}

export async function deleteProjectFile(db: Database, input: { projectId: string; path: string }) {
  await db
    .delete(projectFiles)
    .where(and(eq(projectFiles.projectId, input.projectId), eq(projectFiles.path, input.path)));
}

export async function saveProjectSandbox(
  db: Database,
  input: { projectId: string; sandboxId: string; expiresAt: Date }
) {
  await db
    .update(projects)
    .set({ sandboxId: input.sandboxId, sandboxExpiresAt: input.expiresAt, updatedAt: new Date() })
    .where(eq(projects.id, input.projectId));
}

export async function saveProjectPreview(
  db: Database,
  input: { projectId: string; previewUrl: string }
) {
  await db
    .update(projects)
    .set({ previewUrl: input.previewUrl, updatedAt: new Date() })
    .where(eq(projects.id, input.projectId));
}

export async function createSnapshot(
  db: Database,
  input: { projectId: string; runId: string; storageKey: string }
) {
  return db.transaction(async (tx) => {
    const [snapshot] = await tx.insert(snapshots).values(input).returning();
    if (!snapshot) throw new Error("Failed to create snapshot.");

    await tx
      .update(projects)
      .set({ latestSnapshotId: snapshot.id, updatedAt: new Date() })
      .where(eq(projects.id, input.projectId));

    return snapshot;
  });
}

export async function pruneProjectSnapshots(db: Database, projectId: string, keep = 5) {
  const stale = await db
    .select({ id: snapshots.id, storageKey: snapshots.storageKey })
    .from(snapshots)
    .where(eq(snapshots.projectId, projectId))
    .orderBy(desc(snapshots.createdAt))
    .offset(keep);
  if (stale.length)
    await db.delete(snapshots).where(
      inArray(
        snapshots.id,
        stale.map(({ id }) => id)
      )
    );
  return stale.map(({ storageKey }) => storageKey);
}

export async function finalizeRun(
  db: Database,
  input: { runId: string; projectId: string; workerId: string; summary: string }
) {
  await db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.projectId, input.projectId))
      .orderBy(asc(conversations.createdAt))
      .limit(1);
    if (!conversation) throw new Error("Project conversation was not found.");

    await tx.insert(messages).values({
      conversationId: conversation.id,
      role: "assistant",
      content: input.summary,
      runId: input.runId
    });
    await tx
      .update(runs)
      .set({ status: "completed", heartbeatAt: new Date(), finishedAt: new Date() })
      .where(and(eq(runs.id, input.runId), eq(runs.workerId, input.workerId)));
    await tx
      .update(projects)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(projects.id, input.projectId));
  });
}

export async function deleteProject(db: Database, projectId: string) {
  await db.delete(projects).where(eq(projects.id, projectId));
}
