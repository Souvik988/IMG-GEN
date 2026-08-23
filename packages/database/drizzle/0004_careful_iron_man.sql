CREATE TABLE "retry_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"source_attempt_id" uuid NOT NULL,
	"source_candidate_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"failed_angle" text,
	"critical_defect_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minor_defect_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer_explanation" text,
	"repair_instruction" text NOT NULL,
	"protected_attributes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generation_model_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_candidate_id" uuid,
	"result_decision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "retry_plans" ADD CONSTRAINT "retry_plans_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_plans" ADD CONSTRAINT "retry_plans_source_attempt_id_job_attempts_id_fk" FOREIGN KEY ("source_attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_plans" ADD CONSTRAINT "retry_plans_source_candidate_id_generation_candidates_id_fk" FOREIGN KEY ("source_candidate_id") REFERENCES "public"."generation_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_plans" ADD CONSTRAINT "retry_plans_generation_model_id_model_registry_id_fk" FOREIGN KEY ("generation_model_id") REFERENCES "public"."model_registry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_plans" ADD CONSTRAINT "retry_plans_result_candidate_id_generation_candidates_id_fk" FOREIGN KEY ("result_candidate_id") REFERENCES "public"."generation_candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retry_plans_job_idx" ON "retry_plans" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "retry_plans_source_candidate_idx" ON "retry_plans" USING btree ("source_candidate_id");