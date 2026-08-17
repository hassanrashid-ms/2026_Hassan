-- Tenancy is the highest-risk thing in the build, and it is enforced by the
-- database, not the ORM. Re-runnable: db:setup calls this after every push.

-- 1 - The application role. No BYPASSRLS, no ownership, no DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_app') THEN
    CREATE ROLE support_app LOGIN PASSWORD 'support_app';
  END IF;
END $$;

-- Converge the password unconditionally, every run. The block above only
-- creates the role if absent, so if the password were ever changed out of
-- band, a re-run would otherwise leave support_app unable to authenticate
-- while db:setup still reports success.
ALTER ROLE support_app LOGIN PASSWORD 'support_app';

REVOKE ALL ON SCHEMA public FROM support_app;
GRANT USAGE ON SCHEMA public TO support_app;

-- DELETE is deliberately absent from every grant: "no hard deletes anywhere;
-- don't even write the route."
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO support_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO support_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO support_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO support_app;

-- 2 - The event spine is append-only. Enforced, not conventional.
REVOKE UPDATE, DELETE ON event FROM support_app;
REVOKE UPDATE, DELETE ON event FROM PUBLIC;

-- 2a - change_log is the audit trail. An editable audit trail is not one, so
-- UPDATE and DELETE come straight back off after the blanket GRANT above.
--
-- bot_config deliberately KEEPS UPDATE: its only writer is an
-- INSERT ... ON CONFLICT (workspace_id) DO UPDATE, so revoking here would break
-- the second save on every workspace. Do not "tidy" these two into symmetry.
--
-- form_answer gets the same REVOKE UPDATE treatment when that table lands. It
-- cannot be listed here yet: this file re-runs on every db:setup, and naming a
-- table that does not exist aborts setup for everyone.
REVOKE UPDATE, DELETE ON change_log FROM support_app;
REVOKE UPDATE, DELETE ON change_log FROM PUBLIC;

-- 2b - workspace and agent are the two unscoped tables, but they are NOT
-- treated identically, and that asymmetry is intentional — do not "tidy" it
-- into symmetry.
--
--   workspace: the request path only ever *reads* this table, to verify a
--   game's secret. Writing through support_app would let a compromised or
--   buggy handler rewrite another game's secret_hash and lock its players
--   out of support entirely. Revoked below; workspace rows are provisioned
--   only via the owner/migration connection.
--
--   agent: console sign-in is Google OAuth 2, restricted to the
--   mindstormstudios.com org (docs/decisions/2026-08-04-agent-auth-google-oauth.md).
--   The console's first-login flow upserts an agent row on the request path,
--   so support_app must keep INSERT and UPDATE here — narrowing this to
--   column-scoped grants is future work once the console ships, not now.
REVOKE INSERT, UPDATE ON workspace FROM support_app;

-- ...with one column-scoped exception. conversation.number is allocated on the
-- request path (allocateTicketNumber), which needs to bump this counter and
-- nothing else on the row. Granting the column rather than the table keeps
-- secret_hash unwritable by support_app, which is the whole point of the
-- REVOKE above. This is the same narrowing named as future work for `agent`,
-- applied one table over.
GRANT UPDATE (ticket_seq) ON workspace TO support_app;

-- 3 - One identical policy per scoped table. "Scoped" is defined structurally
-- — any base table in public with a workspace_id column — rather than as a
-- hand-maintained literal list, so a future table can never be born without
-- its policy: forgetting to add it here is no longer possible, because there
-- is no "here" to add it to. workspace and agent have no workspace_id column
-- and are excluded by construction, not by name.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid
            AND a.attname = 'workspace_id'
            AND a.attnum > 0
            AND NOT a.attisdropped
       )
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the policy binds the table owner too. Without this, RLS is
    -- silently inert for any owner connection, including psql. (Locally,
    -- support_owner is itself a superuser, and superusers always bypass RLS
    -- regardless of FORCE — FORCE still matters for any future non-superuser
    -- owner, and costs nothing to set now. See rls.test.ts for what the
    -- FORCE flag can and cannot prove given that.)
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant ON %I', t);
    EXECUTE format(
      $policy$
        CREATE POLICY tenant ON %I
          USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
          WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      $policy$, t);
  END LOOP;
END $$;
