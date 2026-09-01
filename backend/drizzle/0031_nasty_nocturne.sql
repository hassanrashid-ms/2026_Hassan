CREATE TABLE "agent_dashboard_layout" (
	"agent_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"layout" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_dashboard_layout_agent_id_workspace_id_pk" PRIMARY KEY("agent_id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "agent_dashboard_layout" ADD CONSTRAINT "agent_dashboard_layout_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_dashboard_layout" ADD CONSTRAINT "agent_dashboard_layout_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;