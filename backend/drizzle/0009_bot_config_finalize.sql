ALTER TABLE "bot_config" ALTER COLUMN "prompt" SET NOT NULL;
ALTER TABLE "bot_config" ALTER COLUMN "rules" SET NOT NULL;
ALTER TABLE "bot_config" ALTER COLUMN "tools_config" SET NOT NULL;
ALTER TABLE "bot_config" ALTER COLUMN "limits_config" SET NOT NULL;
ALTER TABLE "bot_config" DROP COLUMN "rules_legacy_text";
