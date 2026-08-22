CREATE TYPE "public"."project_status" AS ENUM('draft', 'queued', 'planning', 'generating', 'validating', 'running', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system_event');
--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'planning', 'coding', 'validating', 'completed', 'failed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."file_updated_by" AS ENUM('agent', 'user');
--> statement-breakpoint
CREATE TABLE "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "status" "project_status" DEFAULT 'draft' NOT NULL,
  "sandbox_id" text,
  "sandbox_expires_at" timestamp with time zone,
  "preview_url" text,
  "latest_snapshot_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "role" "message_role" NOT NULL,
  "content" text NOT NULL,
  "run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "trigger_message_id" uuid NOT NULL,
  "status" "run_status" DEFAULT 'queued' NOT NULL,
  "plan_json" jsonb,
  "error_code" text,
  "error_message" text,
  "worker_id" text,
  "heartbeat_at" timestamp with time zone,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "run_id" uuid NOT NULL,
  "type" text NOT NULL,
  "payload_json" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_files" (
  "project_id" uuid NOT NULL,
  "path" text NOT NULL,
  "content" text NOT NULL,
  "content_hash" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "updated_by" "file_updated_by" NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_files_project_id_path_pk" PRIMARY KEY("project_id", "path")
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_latest_snapshot_id_snapshots_id_fk" FOREIGN KEY ("latest_snapshot_id") REFERENCES "public"."snapshots"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE restrict DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE INDEX "projects_user_id_idx" ON "projects" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "conversations_project_id_idx" ON "conversations" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "messages_conversation_id_idx" ON "messages" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX "messages_run_id_idx" ON "messages" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "runs_project_id_idx" ON "runs" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "runs_claim_idx" ON "runs" USING btree ("status", "available_at", "created_at");
--> statement-breakpoint
CREATE INDEX "run_events_run_id_id_idx" ON "run_events" USING btree ("run_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "project_files_project_path_unique" ON "project_files" USING btree ("project_id", "path");
--> statement-breakpoint
CREATE INDEX "snapshots_project_id_idx" ON "snapshots" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "snapshots_run_id_idx" ON "snapshots" USING btree ("run_id");
