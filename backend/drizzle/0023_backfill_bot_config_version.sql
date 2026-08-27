-- BACKFILL — 0022 introduced bot_config_version, but appendBotConfigVersion
-- only ever compares against the PRIOR version row, never against bot_config
-- itself. Any workspace that already had a bot_config row before 0022 landed
-- gets zero version rows here, so its pre-feature state is permanently
-- unreachable from the History tab: the first post-deploy save would mint v1
-- from the POST-save state, silently discarding whatever was live before it.
--
-- Idempotent: only inserts a v1 row for a workspace that has a bot_config row
-- and no bot_config_version row at all, so re-running this after 0022's own
-- seedBotConfig/saveBotConfig path has already written v1 for a workspace is
-- a no-op for that workspace.
--
-- actor/changed_fields convention mirrors seedBotConfig's own v1 write in
-- backend/src/domain/bot/botConfig.ts: the shared system actor
-- (system@internal.support, see backend/src/domain/bot/systemActor.ts), and
-- all four field names, since this is a full snapshot with no way to know
-- which fields were ever actually customised.
DO $$
DECLARE
  system_actor_id uuid;
BEGIN
  SELECT id INTO system_actor_id FROM "agent" WHERE "email" = 'system@internal.support';

  IF system_actor_id IS NULL THEN
    INSERT INTO "agent" ("email", "display_name")
    VALUES ('system@internal.support', 'System')
    RETURNING "id" INTO system_actor_id;
  END IF;

  INSERT INTO "bot_config_version"
    ("workspace_id", "version", "prompt", "rules", "tools_config", "limits_config", "actor_id", "changed_fields")
  SELECT
    bc."workspace_id",
    1,
    bc."prompt",
    bc."rules",
    bc."tools_config",
    bc."limits_config",
    system_actor_id,
    ARRAY['prompt', 'rules', 'tools_config', 'limits_config']
  FROM "bot_config" bc
  WHERE NOT EXISTS (
    SELECT 1 FROM "bot_config_version" bcv WHERE bcv."workspace_id" = bc."workspace_id"
  );
END $$;
