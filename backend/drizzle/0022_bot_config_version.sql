CREATE TABLE "bot_config_version" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"prompt" text NOT NULL,
	"rules" jsonb NOT NULL,
	"tools_config" jsonb NOT NULL,
	"limits_config" jsonb NOT NULL,
	"actor_id" uuid NOT NULL,
	"changed_fields" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_config_version_workspace_version_unique" UNIQUE("workspace_id","version"),
	CONSTRAINT "bot_config_version_has_changes" CHECK (array_length("bot_config_version"."changed_fields", 1) > 0)
);
--> statement-breakpoint
ALTER TABLE "bot_config_version" ADD CONSTRAINT "bot_config_version_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_config_version" ADD CONSTRAINT "bot_config_version_actor_id_agent_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_config_version_workspace_created_idx" ON "bot_config_version" USING btree ("workspace_id","created_at");