ALTER TABLE "runs" ADD COLUMN "model_tokens" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_duration_seconds" integer DEFAULT 0 NOT NULL;
