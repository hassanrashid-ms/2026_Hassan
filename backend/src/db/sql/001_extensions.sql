-- citext backs agent.email. gen_random_uuid() is built in from Postgres 13, so
-- pgcrypto is not needed. pgvector arrives with the knowledge tables in migration 002.
CREATE EXTENSION IF NOT EXISTS citext;
