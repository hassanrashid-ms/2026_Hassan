ALTER TABLE "article_attachment" ALTER COLUMN "storage_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "mime_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "byte_size" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "article_attachment" DROP COLUMN "status";