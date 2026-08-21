CREATE TYPE "public"."asset_kind" AS ENUM('garment_reference', 'detail_reference', 'character_reference', 'generated_candidate', 'preview', 'master', 'jpg_variant');--> statement-breakpoint
CREATE TYPE "public"."asset_validation_status" AS ENUM('pending', 'usable', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('running', 'passed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."defect_severity" AS ENUM('critical', 'major', 'minor');--> statement-breakpoint
CREATE TYPE "public"."feedback_rating" AS ENUM('good', 'needs_improvement');--> statement-breakpoint
CREATE TYPE "public"."input_role" AS ENUM('main_garment', 'detail', 'character');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('created', 'validating', 'analyzing', 'compiling', 'generating', 'reviewing', 'retrying', 'finalizing', 'ready', 'input_rejected', 'failed', 'budget_stopped', 'manual_review', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."model_provider" AS ENUM('openrouter', 'gemini', 'mock');--> statement-breakpoint
CREATE TYPE "public"."model_role" AS ENUM('vision_analyzer', 'prompt_compiler', 'image_generator', 'quality_reviewer', 'second_reviewer');--> statement-breakpoint
CREATE TYPE "public"."resolution" AS ENUM('1k', '2k', '4k');--> statement-breakpoint
CREATE TYPE "public"."review_type" AS ENUM('primary', 'second');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('running', 'succeeded', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."version_status" AS ENUM('draft', 'test', 'production', 'archived');--> statement-breakpoint
CREATE TYPE "public"."workflow_version_status" AS ENUM('draft', 'production', 'archived');--> statement-breakpoint
CREATE TABLE "admin_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"kind" "asset_kind" NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"original_filename" text,
	"mime_type" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"width" integer,
	"height" integer,
	"checksum" text,
	"validation_status" "asset_validation_status" DEFAULT 'pending' NOT NULL,
	"validation_report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "benchmark_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"reference_asset_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_protected_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"human_pass" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benchmark_cases_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "benchmark_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"workflow_version_id" uuid,
	"job_id" uuid,
	"passed" boolean,
	"scores" jsonb,
	"cost_inr" numeric(14, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton_key" text DEFAULT 'global' NOT NULL,
	"warn_inr" numeric(12, 4) DEFAULT '15' NOT NULL,
	"hard_stop_inr" numeric(12, 4) DEFAULT '20' NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"planning_budget_1k_inr" numeric(12, 4) DEFAULT '8' NOT NULL,
	"planning_budget_2k_inr" numeric(12, 4) DEFAULT '20' NOT NULL,
	"planning_budget_4k_inr" numeric(12, 4) DEFAULT '30' NOT NULL,
	"usd_inr_rate" numeric(10, 4) DEFAULT '95.78' NOT NULL,
	"per_user_daily_job_limit" integer DEFAULT 20 NOT NULL,
	"min_garment_fidelity" integer DEFAULT 94 NOT NULL,
	"min_character_identity" integer DEFAULT 90 NOT NULL,
	"min_photorealism" integer DEFAULT 92 NOT NULL,
	"min_anatomy" integer DEFAULT 90 NOT NULL,
	"min_technical_quality" integer DEFAULT 88 NOT NULL,
	"uncertainty_band" integer DEFAULT 3 NOT NULL,
	"min_reviewer_confidence" integer DEFAULT 70 NOT NULL,
	"is_second_review_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_rules_singleton_key_unique" UNIQUE("singleton_key")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview_asset_id" uuid,
	"is_preset" boolean DEFAULT false NOT NULL,
	"owner_id" uuid,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid,
	"attempt_id" uuid,
	"step_run_id" uuid,
	"node_key" text NOT NULL,
	"provider" text NOT NULL,
	"model_id" uuid,
	"model_price_version_id" uuid,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"resolution" text,
	"provider_reported_cost_usd" numeric(14, 8),
	"usd_cost" numeric(14, 8) DEFAULT '0' NOT NULL,
	"fx_rate" numeric(10, 4) DEFAULT '1' NOT NULL,
	"inr_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "defects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quality_review_id" uuid NOT NULL,
	"candidate_id" uuid NOT NULL,
	"severity" "defect_severity" NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"repair_hint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "environment_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"prompt_fragment" text NOT NULL,
	"preview_asset_id" uuid,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_presets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" "feedback_rating" NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "generation_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"sequence" integer DEFAULT 1 NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" "attempt_status" DEFAULT 'running' NOT NULL,
	"prompt_version_id" uuid,
	"compiled_prompt" text,
	"selected_skill_version_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repair_instruction" text,
	"decision" text,
	"decision_reasons" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"role" "input_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"master_asset_id" uuid NOT NULL,
	"preview_asset_id" uuid,
	"jpg_asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_outputs_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "job_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"from_state" "job_state",
	"to_state" "job_state" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid,
	"node_key" text NOT NULL,
	"status" "step_status" DEFAULT 'running' NOT NULL,
	"model_id" uuid,
	"prompt_version_id" uuid,
	"input_ref" jsonb,
	"output_ref" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"state" "job_state" DEFAULT 'created' NOT NULL,
	"requested_resolution" "resolution" DEFAULT '2k' NOT NULL,
	"aspect_ratio" text DEFAULT 'portrait' NOT NULL,
	"output_count" integer DEFAULT 1 NOT NULL,
	"character_id" uuid,
	"character_asset_id" uuid,
	"environment_preset_id" uuid,
	"selections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"truth_sheet" jsonb,
	"truth_sheet_prompt_version_id" uuid,
	"truth_sheet_model_id" uuid,
	"final_decision" text,
	"error" text,
	"total_cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"total_cost_inr" numeric(14, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_price_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"input_price_per_m" numeric(12, 6),
	"output_price_per_m" numeric(12, 6),
	"image_prices" jsonb,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" "model_provider" NOT NULL,
	"model_id" text NOT NULL,
	"role" "model_role" NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prompt_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "quality_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"review_type" "review_type" DEFAULT 'primary' NOT NULL,
	"reviewer_model_id" uuid,
	"prompt_version_id" uuid,
	"review" jsonb NOT NULL,
	"repair_instruction" text,
	"garment_fidelity_score" integer,
	"character_identity_score" integer,
	"photorealism_score" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"description" text,
	"conditions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "version_status" DEFAULT 'draft' NOT NULL,
	"instruction" text NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"purpose" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workflow_node_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"model_id" uuid,
	"prompt_version_id" uuid,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"max_retries" integer DEFAULT 1 NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_node_configs_node_id_unique" UNIQUE("node_id")
);
--> statement-breakpoint
CREATE TABLE "workflow_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"name" text NOT NULL,
	"node_type" text DEFAULT 'standard' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "workflow_version_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflows_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_runs" ADD CONSTRAINT "benchmark_runs_case_id_benchmark_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."benchmark_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_runs" ADD CONSTRAINT "benchmark_runs_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmark_runs" ADD CONSTRAINT "benchmark_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_attempt_id_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_step_run_id_job_step_runs_id_fk" FOREIGN KEY ("step_run_id") REFERENCES "public"."job_step_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_model_id_model_registry_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_registry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_model_price_version_id_model_price_versions_id_fk" FOREIGN KEY ("model_price_version_id") REFERENCES "public"."model_price_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_quality_review_id_quality_reviews_id_fk" FOREIGN KEY ("quality_review_id") REFERENCES "public"."quality_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "defects" ADD CONSTRAINT "defects_candidate_id_generation_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."generation_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_presets" ADD CONSTRAINT "environment_presets_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_candidates" ADD CONSTRAINT "generation_candidates_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_candidates" ADD CONSTRAINT "generation_candidates_attempt_id_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_candidates" ADD CONSTRAINT "generation_candidates_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_inputs" ADD CONSTRAINT "job_inputs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_master_asset_id_assets_id_fk" FOREIGN KEY ("master_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_preview_asset_id_assets_id_fk" FOREIGN KEY ("preview_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD CONSTRAINT "job_outputs_jpg_asset_id_assets_id_fk" FOREIGN KEY ("jpg_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_state_events" ADD CONSTRAINT "job_state_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_step_runs" ADD CONSTRAINT "job_step_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_step_runs" ADD CONSTRAINT "job_step_runs_attempt_id_job_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."job_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_step_runs" ADD CONSTRAINT "job_step_runs_model_id_model_registry_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_registry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_step_runs" ADD CONSTRAINT "job_step_runs_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_character_asset_id_assets_id_fk" FOREIGN KEY ("character_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_environment_preset_id_environment_presets_id_fk" FOREIGN KEY ("environment_preset_id") REFERENCES "public"."environment_presets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_truth_sheet_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("truth_sheet_prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_truth_sheet_model_id_model_registry_id_fk" FOREIGN KEY ("truth_sheet_model_id") REFERENCES "public"."model_registry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_price_versions" ADD CONSTRAINT "model_price_versions_model_id_model_registry_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_registry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_candidate_id_generation_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."generation_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_reviewer_model_id_model_registry_id_fk" FOREIGN KEY ("reviewer_model_id") REFERENCES "public"."model_registry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_reviews" ADD CONSTRAINT "quality_reviews_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_rules" ADD CONSTRAINT "skill_rules_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_configs" ADD CONSTRAINT "workflow_node_configs_node_id_workflow_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."workflow_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_configs" ADD CONSTRAINT "workflow_node_configs_model_id_model_registry_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_registry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_configs" ADD CONSTRAINT "workflow_node_configs_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_nodes" ADD CONSTRAINT "workflow_nodes_workflow_version_id_workflow_versions_id_fk" FOREIGN KEY ("workflow_version_id") REFERENCES "public"."workflow_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD CONSTRAINT "workflow_versions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_entity_idx" ON "admin_audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "admin_audit_created_idx" ON "admin_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "assets_user_idx" ON "assets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_bucket_key_idx" ON "assets" USING btree ("bucket","object_key");--> statement-breakpoint
CREATE INDEX "benchmark_runs_case_idx" ON "benchmark_runs" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cost_events_job_idx" ON "cost_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "cost_events_created_idx" ON "cost_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cost_events_model_idx" ON "cost_events" USING btree ("model_id");--> statement-breakpoint
CREATE INDEX "defects_review_idx" ON "defects" USING btree ("quality_review_id");--> statement-breakpoint
CREATE INDEX "defects_candidate_idx" ON "defects" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "generation_candidates_job_idx" ON "generation_candidates" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_attempts_unique" ON "job_attempts" USING btree ("job_id","attempt_number");--> statement-breakpoint
CREATE INDEX "job_attempts_job_idx" ON "job_attempts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_inputs_job_idx" ON "job_inputs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_outputs_job_idx" ON "job_outputs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_state_events_job_idx" ON "job_state_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_step_runs_job_idx" ON "job_step_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_step_runs_attempt_idx" ON "job_step_runs" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "jobs_user_created_idx" ON "jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_state_idx" ON "jobs" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "model_price_versions_unique" ON "model_price_versions" USING btree ("model_id","version");--> statement-breakpoint
CREATE INDEX "model_price_versions_model_idx" ON "model_price_versions" USING btree ("model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_registry_unique" ON "model_registry" USING btree ("provider","model_id","role");--> statement-breakpoint
CREATE INDEX "model_registry_role_idx" ON "model_registry" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_unique" ON "prompt_versions" USING btree ("prompt_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_one_production" ON "prompt_versions" USING btree ("prompt_id") WHERE status = 'production';--> statement-breakpoint
CREATE INDEX "quality_reviews_candidate_idx" ON "quality_reviews" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "skill_rules_skill_idx" ON "skill_rules" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_unique" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_one_production" ON "skill_versions" USING btree ("skill_id") WHERE status = 'production';--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workflow_node_configs_node_idx" ON "workflow_node_configs" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_nodes_unique" ON "workflow_nodes" USING btree ("workflow_version_id","node_key");--> statement-breakpoint
CREATE INDEX "workflow_nodes_version_idx" ON "workflow_nodes" USING btree ("workflow_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_versions_unique" ON "workflow_versions" USING btree ("workflow_id","version");