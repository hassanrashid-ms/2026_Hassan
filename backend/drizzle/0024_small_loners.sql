CREATE TYPE "public"."article_version_status" AS ENUM('draft', 'published', 'discarded');--> statement-breakpoint
CREATE TABLE "article_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"status" "article_version_status" DEFAULT 'draft' NOT NULL,
	"version" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"keywords" text[] DEFAULT '{}' NOT NULL,
	"attachment_ids" uuid[] DEFAULT '{}' NOT NULL,
	"actor_id" uuid NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_version_article_version_unique" UNIQUE("article_id","version")
);
--> statement-breakpoint
ALTER TABLE "article" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "draft_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "pending_removal_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "article_version" ADD CONSTRAINT "article_version_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_version" ADD CONSTRAINT "article_version_actor_id_agent_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "article_version_article_created_idx" ON "article_version" USING btree ("article_id","created_at");