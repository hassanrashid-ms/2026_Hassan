ALTER TABLE "attachment" ADD COLUMN "filename" text;
UPDATE "attachment" SET "filename" = 'unknown' WHERE "filename" IS NULL;
ALTER TABLE "attachment" ALTER COLUMN "filename" SET NOT NULL;