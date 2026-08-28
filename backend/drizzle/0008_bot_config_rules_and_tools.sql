-- Add the new columns now, nullable — the backfill script populates them before
-- the NOT NULL constraint lands in the finalize migration.
ALTER TABLE "bot_config" ADD COLUMN "tools_config" jsonb;
ALTER TABLE "bot_config" ADD COLUMN "limits_config" jsonb;

-- rules moves from free text to a structured RuleEntry[] array. The old column
-- is kept under a new name until the backfill script has read it — dropping it
-- in the same migration that adds the replacement would lose the one thing the
-- backfill needs to preserve (an admin's existing free-text customisation).
ALTER TABLE "bot_config" RENAME COLUMN "rules" TO "rules_legacy_text";
ALTER TABLE "bot_config" ADD COLUMN "rules" jsonb;
