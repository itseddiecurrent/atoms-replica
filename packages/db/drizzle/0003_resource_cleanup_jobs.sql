CREATE TYPE "public"."resource_cleanup_status" AS ENUM('queued', 'processing', 'completed', 'failed');
--> statement-breakpoint
CREATE TABLE "resource_cleanup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"sandbox_id" text,
	"snapshot_storage_keys" jsonb NOT NULL,
	"status" "resource_cleanup_status" DEFAULT 'queued' NOT NULL,
	"error_message" text,
	"worker_id" text,
	"heartbeat_at" timestamp with time zone,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "resource_cleanup_jobs_user_id_idx" ON "resource_cleanup_jobs" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "resource_cleanup_jobs_claim_idx" ON "resource_cleanup_jobs" USING btree ("status", "available_at", "created_at");
