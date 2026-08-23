CREATE TYPE "public"."identity_reference_role" AS ENUM('front', 'three_quarter', 'full_body');--> statement-breakpoint
CREATE TABLE "character_identity_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"character_id" uuid NOT NULL,
	"role" "identity_reference_role" NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_identity_references" ADD CONSTRAINT "character_identity_references_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_identity_references" ADD CONSTRAINT "character_identity_references_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "character_identity_references_unique" ON "character_identity_references" USING btree ("character_id","role");--> statement-breakpoint
CREATE INDEX "character_identity_references_character_idx" ON "character_identity_references" USING btree ("character_id");