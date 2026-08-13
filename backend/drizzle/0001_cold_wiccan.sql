CREATE TYPE "public"."bot_phase" AS ENUM('none', 'article_confirm');--> statement-breakpoint
CREATE TYPE "public"."resolution_source" AS ENUM('bot', 'agent');--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "bot_phase" "bot_phase" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "resolution_source" "resolution_source";