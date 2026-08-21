ALTER TABLE "job_outputs" DROP CONSTRAINT "job_outputs_job_id_unique";--> statement-breakpoint
ALTER TABLE "generation_candidates" ADD COLUMN "camera_angle" text;--> statement-breakpoint
ALTER TABLE "generation_candidates" ADD COLUMN "is_anchor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN "sequence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_outputs" ADD COLUMN "camera_angle" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "camera_angles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "job_outputs_job_sequence_unique" ON "job_outputs" USING btree ("job_id","sequence");