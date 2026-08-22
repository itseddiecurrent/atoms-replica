CREATE TYPE "public"."runtime_job_type" AS ENUM('sync_file', 'restart_preview');
--> statement-breakpoint
CREATE TYPE "public"."runtime_job_status" AS ENUM('queued', 'processing', 'completed', 'failed');
--> statement-breakpoint
CREATE TABLE "runtime_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "type" "runtime_job_type" NOT NULL,
  "status" "runtime_job_status" DEFAULT 'queued' NOT NULL,
  "payload_json" jsonb NOT NULL,
  "result_json" jsonb,
  "error_message" text,
  "worker_id" text,
  "heartbeat_at" timestamp with time zone,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_jobs" ADD CONSTRAINT "runtime_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "runtime_jobs_project_id_idx" ON "runtime_jobs" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX "runtime_jobs_claim_idx" ON "runtime_jobs" USING btree ("status", "available_at", "created_at");
