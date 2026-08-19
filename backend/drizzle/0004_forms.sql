-- Order matters, per docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md
-- §Migration. Steps 2-3 must precede the FKs that depend on them:
--   1. the two enums
--   2. conversation UNIQUE (workspace_id, id)   -- parent key for step 5
--   3. form (with its UNIQUE (workspace_id, id)), then form_version
--   4. the composite FK on subintent.form_id     -- depends on step 3
--   5. form_submission, then form_answer         -- depend on steps 2, 3
-- Every existing subintent row has form_id IS NULL, so no data fails step 4.
-- 002_rls.sql (spec step 8) runs after this, from db:setup.

-- 1. the two enums
CREATE TYPE "public"."form_field_type" AS ENUM('short_text', 'long_text', 'number', 'date', 'time', 'choice', 'attachment');--> statement-breakpoint
CREATE TYPE "public"."form_status" AS ENUM('in_progress', 'completed', 'partial', 'skipped');--> statement-breakpoint

-- 2. conversation UNIQUE (workspace_id, id) — parent key for form_submission_conversation_fk
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_workspace_id_uk" UNIQUE("workspace_id","id");--> statement-breakpoint

-- 3. form table, then form_version
CREATE TABLE "form" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_workspace_id_uk" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "form" ADD CONSTRAINT "form_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form" ADD CONSTRAINT "form_created_by_agent_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_workspace_name_uk" ON "form" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE TABLE "form_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_published_by_agent_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_version" ADD CONSTRAINT "form_version_form_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."form"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_version_form_version_uk" ON "form_version" USING btree ("form_id","version");--> statement-breakpoint

-- 4. composite FK on subintent.form_id — depends on step 3 (form must exist)
-- Every existing subintent row has form_id IS NULL, so no data fails this step.
ALTER TABLE "subintent" ADD CONSTRAINT "subintent_form_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."form"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- 5. form_submission and form_answer — depend on steps 2 and 3
CREATE TABLE "form_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"form_version" integer NOT NULL,
	"status" "form_status" DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	CONSTRAINT "form_submission_workspace_id_uk" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_form_fk" FOREIGN KEY ("workspace_id","form_id") REFERENCES "public"."form"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_submission" ADD CONSTRAINT "form_submission_version_fk" FOREIGN KEY ("form_id","form_version") REFERENCES "public"."form_version"("form_id","version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_submission_conversation_form_uk" ON "form_submission" USING btree ("conversation_id","form_id");--> statement-breakpoint
CREATE TABLE "form_answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"form_submission_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"field_type" "form_field_type" NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "form_answer" ADD CONSTRAINT "form_answer_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_answer" ADD CONSTRAINT "form_answer_submission_fk" FOREIGN KEY ("workspace_id","form_submission_id") REFERENCES "public"."form_submission"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_answer_submission_field_idx" ON "form_answer" USING btree ("form_submission_id","field_key","created_at");