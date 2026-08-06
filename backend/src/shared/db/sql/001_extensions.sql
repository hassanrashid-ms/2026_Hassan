-- citext backs agent.email. gen_random_uuid() is built in from Postgres 13, so
-- pgcrypto is not needed. pgvector backs article_embedding.embedding.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
