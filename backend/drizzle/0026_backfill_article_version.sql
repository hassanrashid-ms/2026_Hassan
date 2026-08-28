-- BACKFILL — existing published articles predate article_version. Without this,
-- their History tab would be permanently empty: the first post-deploy edit's publish
-- would mint v1 from the POST-edit state, discarding the fact that the article was
-- ever live before this feature shipped.
--
-- Idempotent: only inserts a v1 row for a published article with no article_version
-- row at all.
INSERT INTO "article_version"
  ("article_id", "status", "version", "title", "body", "keywords", "attachment_ids",
   "actor_id", "changed_fields", "created_at")
SELECT
  a."id",
  'published',
  1,
  a."title",
  a."body",
  a."keywords",
  COALESCE(
    (SELECT array_agg(aa."id") FROM "article_attachment" aa
     WHERE aa."article_id" = a."id" AND aa."removed_at" IS NULL AND aa."draft_only" = false),
    '{}'
  ),
  a."published_by",
  ARRAY['title', 'body', 'keywords'],
  a."published_at"
FROM "article" a
WHERE a."state" = 'published'
  AND a."published_by" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "article_version" av WHERE av."article_id" = a."id"
  );

UPDATE "article" a SET "version" = 1
WHERE a."state" = 'published'
  AND EXISTS (
    SELECT 1 FROM "article_version" av
    WHERE av."article_id" = a."id" AND av."version" = 1
  );
