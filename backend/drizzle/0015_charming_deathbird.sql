ALTER TABLE "workspace" ADD COLUMN "max_assigned_tickets" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "inactivity_window_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace" ADD COLUMN "form_timeout_minutes" integer DEFAULT 30 NOT NULL;