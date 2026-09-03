CREATE TABLE "rate_limit_hit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"key_type" text NOT NULL,
	"key_value" text NOT NULL,
	"path" text NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_hit_tier_created_idx" ON "rate_limit_hit" USING btree ("tier","created_at");--> statement-breakpoint
CREATE INDEX "rate_limit_hit_key_value_created_idx" ON "rate_limit_hit" USING btree ("key_value","created_at");