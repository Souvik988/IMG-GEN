ALTER TABLE "generation_candidates" ADD COLUMN "decision" text;--> statement-breakpoint
ALTER TABLE "generation_candidates" ADD COLUMN "decision_reasons" jsonb DEFAULT '[]'::jsonb;