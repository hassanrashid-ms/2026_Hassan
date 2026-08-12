CREATE TYPE "public"."agent_status" AS ENUM('active', 'on_leave', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."article_state" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."classification_source" AS ENUM('bot', 'agent');--> statement-breakpoint
CREATE TYPE "public"."conversation_priority" AS ENUM('p1', 'p2', 'p3', 'p4');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('new', 'bot_active', 'open', 'awaiting_player', 'escalated', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."declared_field_type" AS ENUM('string', 'number', 'boolean', 'timestamp');--> statement-breakpoint
CREATE TYPE "public"."event_actor_type" AS ENUM('player', 'agent', 'bot', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_author_type" AS ENUM('player', 'agent', 'bot', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_state" AS ENUM('sending', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TYPE "public"."message_visibility" AS ENUM('public', 'internal');--> statement-breakpoint
CREATE TYPE "public"."session_end_reason" AS ENUM('client', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('agent', 'team_lead', 'admin');--> statement-breakpoint
CREATE TABLE "agent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"google_subject" text,
	"display_name" text NOT NULL,
	"status" "agent_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_email_unique" UNIQUE("email"),
	CONSTRAINT "agent_google_subject_unique" UNIQUE("google_subject")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"secret_hash" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "workspace_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"deactivated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"entry_point" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by" "session_end_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "declared_field" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "declared_field_type" NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"declared_by" uuid
);
--> statement-breakpoint
CREATE TABLE "player_state_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"declared" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_missing" boolean DEFAULT false NOT NULL,
	"degraded_reason" text,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"session_id" uuid,
	"status" "conversation_status" DEFAULT 'bot_active' NOT NULL,
	"priority" "conversation_priority" DEFAULT 'p3' NOT NULL,
	"assigned_agent_id" uuid,
	"classification_source" "classification_source",
	"subintent_id" uuid,
	"message_seq" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"author_type" "message_author_type" NOT NULL,
	"author_agent_id" uuid,
	"body" text NOT NULL,
	"visibility" "message_visibility" DEFAULT 'public' NOT NULL,
	"delivery_state" "message_delivery_state" DEFAULT 'sent' NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"conversation_id" uuid,
	"session_id" uuid,
	"actor_id" uuid,
	"actor_type" "event_actor_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subintent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"default_priority" "conversation_priority",
	"form_id" uuid,
	"merged_into_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subintent_workspace_id_uk" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "article" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"intent_id" uuid,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"keywords" text[] DEFAULT '{}' NOT NULL,
	"state" "article_state" DEFAULT 'draft' NOT NULL,
	"created_by" uuid NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"storage_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_config" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"is_provisioned" boolean DEFAULT false NOT NULL,
	"prompt" text,
	"rules" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"actor_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_log_value_changed" CHECK ("change_log"."before_value" is distinct from "change_log"."after_value")
);
--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_member" ADD CONSTRAINT "workspace_member_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player" ADD CONSTRAINT "player_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declared_field" ADD CONSTRAINT "declared_field_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declared_field" ADD CONSTRAINT "declared_field_declared_by_agent_id_fk" FOREIGN KEY ("declared_by") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_state_snapshot" ADD CONSTRAINT "player_state_snapshot_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_state_snapshot" ADD CONSTRAINT "player_state_snapshot_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_player_id_player_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."player"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_assigned_agent_id_agent_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_subintent_fk" FOREIGN KEY ("workspace_id","subintent_id") REFERENCES "public"."subintent"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_agent_id_agent_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent" ADD CONSTRAINT "intent_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subintent" ADD CONSTRAINT "subintent_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subintent" ADD CONSTRAINT "subintent_intent_id_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subintent" ADD CONSTRAINT "subintent_merged_into_id_subintent_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."subintent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_intent_id_intent_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_created_by_agent_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article" ADD CONSTRAINT "article_published_by_agent_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD CONSTRAINT "article_attachment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD CONSTRAINT "article_attachment_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_config" ADD CONSTRAINT "bot_config_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_log" ADD CONSTRAINT "change_log_actor_id_agent_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_workspace_agent_uk" ON "workspace_member" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_workspace_external_uk" ON "player" USING btree ("workspace_id","external_id");--> statement-breakpoint
CREATE INDEX "session_workspace_started_idx" ON "session" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "session_open_started_idx" ON "session" USING btree ("started_at") WHERE ended_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "declared_field_workspace_key_uk" ON "declared_field" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "player_state_snapshot_session_uk" ON "player_state_snapshot" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "player_state_snapshot_declared_gin" ON "player_state_snapshot" USING gin ("declared" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "conversation_workspace_player_idx" ON "conversation" USING btree ("workspace_id","player_id");--> statement-breakpoint
CREATE INDEX "conversation_workspace_subintent_idx" ON "conversation" USING btree ("workspace_id","subintent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_conversation_seq_uk" ON "message" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "message_unread_idx" ON "message" USING btree ("conversation_id","delivery_state","author_type");--> statement-breakpoint
CREATE INDEX "event_occurred_brin" ON "event" USING brin ("occurred_at");--> statement-breakpoint
CREATE INDEX "event_conversation_occurred_idx" ON "event" USING btree ("conversation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "event_session_type_idx" ON "event" USING btree ("session_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_workspace_name_uk" ON "intent" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "subintent_workspace_intent_name_uk" ON "subintent" USING btree ("workspace_id","intent_id","name");--> statement-breakpoint
CREATE INDEX "change_log_entity_changed_idx" ON "change_log" USING btree ("workspace_id","entity_type","entity_id","changed_at");--> statement-breakpoint
CREATE INDEX "change_log_changed_brin" ON "change_log" USING brin ("changed_at");