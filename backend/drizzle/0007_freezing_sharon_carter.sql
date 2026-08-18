ALTER TYPE "public"."confirm_phase" ADD VALUE 'inactivity_ask';--> statement-breakpoint
ALTER TYPE "public"."resolution_source" ADD VALUE 'player_confirmed';--> statement-breakpoint
ALTER TYPE "public"."resolution_source" ADD VALUE 'timed_out';--> statement-breakpoint
CREATE TABLE "resolution_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"cycle_no" integer NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_human_reply_at" timestamp with time zone,
	"inactivity_due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_kind" "resolution_source",
	"closed_at" timestamp with time zone,
	"support_owed_flag" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "auto_close_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "resolution_cycle" ADD CONSTRAINT "resolution_cycle_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_cycle" ADD CONSTRAINT "resolution_cycle_conversation_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversation"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "resolution_cycle_open_uk" ON "resolution_cycle" USING btree ("conversation_id") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "resolution_cycle_due_idx" ON "resolution_cycle" USING btree ("workspace_id","inactivity_due_at") WHERE resolved_at is null;--> statement-breakpoint
CREATE INDEX "resolution_cycle_autoclose_idx" ON "resolution_cycle" USING btree ("workspace_id","resolved_at") WHERE closed_at is null and resolved_at is not null;