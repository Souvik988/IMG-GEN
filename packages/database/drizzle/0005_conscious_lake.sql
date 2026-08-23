CREATE TABLE "execution_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"workflow_version_number" integer NOT NULL,
	"nodes_snapshot" jsonb NOT NULL,
	"models_snapshot" jsonb NOT NULL,
	"skills_snapshot" jsonb NOT NULL,
	"quality_rules_snapshot" jsonb NOT NULL,
	"budget_rules_snapshot" jsonb NOT NULL,
	"fx_rate" numeric(10, 4) NOT NULL,
	"manifest_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_manifests_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "execution_manifests" ADD CONSTRAINT "execution_manifests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_manifests_job_idx" ON "execution_manifests" USING btree ("job_id");