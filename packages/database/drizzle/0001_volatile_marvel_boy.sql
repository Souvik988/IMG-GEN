ALTER TABLE "jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "idempotency_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_user_idempotency_unique" ON "jobs" USING btree ("user_id","idempotency_key");