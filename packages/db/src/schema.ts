import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const projectStatusEnum = pgEnum("project_status", [
  "draft",
  "queued",
  "planning",
  "generating",
  "validating",
  "running",
  "failed"
]);

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant", "system_event"]);

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "planning",
  "coding",
  "validating",
  "completed",
  "failed",
  "cancelled"
]);

export const fileUpdatedByEnum = pgEnum("file_updated_by", ["agent", "user"]);

export const runtimeJobTypeEnum = pgEnum("runtime_job_type", ["sync_file", "restart_preview"]);

export const runtimeJobStatusEnum = pgEnum("runtime_job_status", [
  "queued",
  "processing",
  "completed",
  "failed"
]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: projectStatusEnum("status").default("draft").notNull(),
    sandboxId: text("sandbox_id"),
    sandboxExpiresAt: timestamp("sandbox_expires_at", { withTimezone: true }),
    previewUrl: text("preview_url"),
    latestSnapshotId: uuid("latest_snapshot_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [index("projects_user_id_idx").on(table.userId)]
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [index("conversations_project_id_idx").on(table.projectId)]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    runId: uuid("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("messages_conversation_id_idx").on(table.conversationId),
    index("messages_run_id_idx").on(table.runId)
  ]
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    triggerMessageId: uuid("trigger_message_id").notNull(),
    status: runStatusEnum("status").default("queued").notNull(),
    planJson: jsonb("plan_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    modelTokens: integer("model_tokens").default(0).notNull(),
    sandboxDurationSeconds: integer("sandbox_duration_seconds").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("runs_project_id_idx").on(table.projectId),
    index("runs_claim_idx").on(table.status, table.availableAt, table.createdAt)
  ]
);

export const runEvents = pgTable(
  "run_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [index("run_events_run_id_id_idx").on(table.runId, table.id)]
);

export const projectFiles = pgTable(
  "project_files",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    version: integer("version").default(1).notNull(),
    updatedBy: fileUpdatedByEnum("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    primaryKey({ columns: [table.projectId, table.path] }),
    uniqueIndex("project_files_project_path_unique").on(table.projectId, table.path)
  ]
);

export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("snapshots_project_id_idx").on(table.projectId),
    index("snapshots_run_id_idx").on(table.runId)
  ]
);

export const runtimeJobs = pgTable(
  "runtime_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: runtimeJobTypeEnum("type").notNull(),
    status: runtimeJobStatusEnum("status").default("queued").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    resultJson: jsonb("result_json"),
    errorMessage: text("error_message"),
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    index("runtime_jobs_project_id_idx").on(table.projectId),
    index("runtime_jobs_claim_idx").on(table.status, table.availableAt, table.createdAt)
  ]
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof runEvents.$inferSelect;
export type ProjectFile = typeof projectFiles.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
export type RuntimeJob = typeof runtimeJobs.$inferSelect;
