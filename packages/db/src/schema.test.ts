import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  conversations,
  messages,
  projectFiles,
  projects,
  runtimeJobs,
  runEvents,
  runs,
  snapshots,
  users
} from "./schema";

describe("database schema", () => {
  it("defines every Step 2 table", () => {
    expect(
      [
        users,
        projects,
        conversations,
        messages,
        runs,
        runEvents,
        projectFiles,
        snapshots,
        runtimeJobs
      ].map(getTableName)
    ).toEqual([
      "users",
      "projects",
      "conversations",
      "messages",
      "runs",
      "run_events",
      "project_files",
      "snapshots",
      "runtime_jobs"
    ]);
  });

  it("defines a durable runtime job queue", () => {
    expect(Object.keys(runtimeJobs)).toEqual(
      expect.arrayContaining([
        "projectId",
        "type",
        "status",
        "payloadJson",
        "workerId",
        "heartbeatAt",
        "availableAt"
      ])
    );
  });

  it("exposes the required queue columns", () => {
    expect(Object.keys(runs)).toEqual(
      expect.arrayContaining([
        "workerId",
        "heartbeatAt",
        "attemptCount",
        "modelTokens",
        "sandboxDurationSeconds",
        "availableAt"
      ])
    );
  });

  it("uses a composite project file identity", () => {
    expect(projectFiles.projectId).toBeDefined();
    expect(projectFiles.path).toBeDefined();
    expect(projectFiles.version).toBeDefined();
  });
});
