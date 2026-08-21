CREATE TABLE "workspace_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "workspace_secret" ADD CONSTRAINT "workspace_secret_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Backfill: every existing workspace's single secret becomes its one active
-- workspace_secret row (expires_at null) before the column it came from is dropped.
INSERT INTO "workspace_secret" (workspace_id, secret_hash)
SELECT id, secret_hash FROM "workspace";
--> statement-breakpoint
ALTER TABLE "workspace" DROP COLUMN "secret_hash";
