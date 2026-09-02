CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"type" text NOT NULL,
	"conversation_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_agent_workspace_read_idx" ON "notification" USING btree ("agent_id","workspace_id","read_at");