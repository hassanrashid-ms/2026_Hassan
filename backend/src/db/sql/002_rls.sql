-- Tenancy is the highest-risk thing in the build, and it is enforced by the
-- database, not the ORM. Re-runnable: db:setup calls this after every push.

-- 1 - The application role. No BYPASSRLS, no ownership, no DDL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'support_app') THEN
    CREATE ROLE support_app LOGIN PASSWORD 'support_app';
  END IF;
END $$;

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

-- 3 - One identical policy per scoped table. Exactly two tables are unscoped:
--     workspace and agent.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workspace_member', 'player', 'session', 'player_state_snapshot',
    'declared_field', 'conversation', 'message', 'event'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE so the policy binds the table owner too. Without this, RLS is
    -- silently inert for any owner connection, including psql.
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
