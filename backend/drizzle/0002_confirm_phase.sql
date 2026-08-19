-- bot_phase shipped in 0001 with values ('none','article_confirm'). This is the
-- rename the 2026-08-13 resolution-confirmation spec assumed was free: the
-- column is on no wire, so renaming it costs nothing beyond this file.
ALTER TYPE "public"."bot_phase" RENAME TO "confirm_phase";--> statement-breakpoint
ALTER TYPE "public"."confirm_phase" RENAME VALUE 'article_confirm' TO 'bot_article';--> statement-breakpoint
ALTER TYPE "public"."confirm_phase" ADD VALUE 'agent_ask';--> statement-breakpoint
ALTER TABLE "conversation" RENAME COLUMN "bot_phase" TO "confirm_phase";
