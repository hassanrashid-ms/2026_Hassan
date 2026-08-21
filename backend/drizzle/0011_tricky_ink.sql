ALTER TYPE "public"."agent_status" ADD VALUE 'invited';--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "is_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;