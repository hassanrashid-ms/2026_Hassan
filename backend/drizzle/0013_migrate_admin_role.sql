-- 1. Backfill: every agent who held an 'admin' workspace_member row in ANY
--    workspace becomes globally is_admin. Distinct because the same agent could
--    hold 'admin' in more than one workspace before this migration.
UPDATE agent
   SET is_admin = true
  FROM workspace_member
 WHERE workspace_member.agent_id = agent.id
   AND workspace_member.role = 'admin';
--> statement-breakpoint

-- 2. Those rows are now redundant: an admin has implicit access to every
--    workspace and holds no workspace_member row at all under the new model.
DELETE FROM workspace_member WHERE role = 'admin';
--> statement-breakpoint

-- 3. Postgres has no ALTER TYPE ... DROP VALUE — recreate the enum without it.
CREATE TYPE "workspace_role_new" AS ENUM ('agent', 'team_lead');
--> statement-breakpoint
ALTER TABLE "workspace_member"
  ALTER COLUMN "role" TYPE "workspace_role_new"
  USING "role"::text::"workspace_role_new";
--> statement-breakpoint
DROP TYPE "workspace_role";
--> statement-breakpoint
ALTER TYPE "workspace_role_new" RENAME TO "workspace_role";
