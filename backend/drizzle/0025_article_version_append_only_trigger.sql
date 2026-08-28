-- Published article_version rows are append-only, same reasoning as change_log and
-- bot_config_version — but unlike those tables, this one also holds mutable draft
-- rows (status='draft'), so a blanket REVOKE UPDATE would break draft editing. A
-- per-row trigger enforces "published rows never change" precisely instead.
CREATE OR REPLACE FUNCTION prevent_published_article_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'article_version rows with status=published are append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER article_version_append_only
BEFORE UPDATE OR DELETE ON article_version
FOR EACH ROW EXECUTE FUNCTION prevent_published_article_version_mutation();

-- At most one in-progress draft per article.
CREATE UNIQUE INDEX article_version_one_draft_per_article
ON article_version (article_id)
WHERE status = 'draft';
