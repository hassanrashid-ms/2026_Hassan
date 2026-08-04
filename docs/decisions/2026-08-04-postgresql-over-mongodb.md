# ADR 001 — PostgreSQL over MongoDB

**Date:** 2026-08-04
**Status:** Accepted
**Reverses:** the `Database: MongoDB` / `ODM: Mongoose 8` / `Bot retrieval: Atlas Vector Search` rows
in `CLAUDE.md` and `README.md`
**Full schema:** [`../specs/2026-08-04-database-and-schema-design.md`](../specs/2026-08-04-database-and-schema-design.md)

## Context

The stack was written up before the deployment target was settled. It specified MongoDB with
Mongoose 8, chosen "specifically for the plugin/hook system the tenancy guard needs," and Atlas Vector
Search for bot retrieval with a hedge: "or in-memory cosine if self-hosting."

The deployment target is now decided: **self-hosted, Docker only.** No managed database, no Atlas.

No application code exists. `frontend/` and `backend/` contain nothing but a README. There is no
schema to migrate, no data to move and no code to rewrite.

## Decision

**PostgreSQL 17 (`pgvector/pgvector:pg17`), accessed through Drizzle ORM, with tenant isolation
enforced by Row-Level Security and bot retrieval by pgvector.**

Redis and BullMQ are unchanged. Object storage is unchanged.

## Rationale

### 1. Self-hosted MongoDB has no vector search

Atlas Search and Atlas Vector Search run as a separate `mongot` process that exists **only on Atlas**.
It is not in Community Edition. Self-hosting MongoDB therefore leaves the documented fallback:
in-memory cosine over every published article, held per API replica and reloaded on every process
start — so a manual re-sync only fixes the instance that served the request. That is a poor foundation
for the one feature that *is* the bot.

`pgvector` is one line in a compose file and runs an HNSW index in the same database as everything
else.

### 2. RLS is a stronger tenancy boundary than an ODM hook

The docs call cross-workspace isolation "the highest-risk thing in the build." A Mongoose global
plugin with `pre` hooks is bypassed by `.aggregate()` — which the docs themselves flag as "the one
people forget" — by paths that skip middleware, and by any raw driver call.

An RLS policy is enforced by the engine. A query with no `workspace_id` predicate returns zero rows,
and there is no code path around it, including raw SQL and `psql`.

This also removes the stated reason for choosing Mongoose. With the guard in the database, the access
layer stops being the security boundary, which frees the ORM choice.

### 3. Reporting is analytical work

Nine metrics over an append-only event log, with an arbitrary date range plus a separate comparison
period and a sparkline on every headline number. "Resolutions per *active agent-day*, split
player-confirmed vs timed out, versus the prior period" is `GROUP BY` with `FILTER`, window functions
and `generate_series` for gap-filling. The MongoDB equivalent is several hundred lines of `$facet`
nobody wants to modify in week 3.

### 4. "Nothing is deleted" becomes a schema guarantee

Foreign keys with `ON DELETE RESTRICT` make the rule structural. On MongoDB it stays a code convention
enforced by everyone remembering.

### 5. The one MongoDB advantage is covered

The freeform `state.raw` blob from the SDK — arbitrary keys, no schema, never dropped — is `JSONB`
with a GIN index. The wildcard-index-on-`state.declared` design maps onto a GIN index one-for-one.

## Alternatives considered

### MongoDB Atlas

Rejected: unavailable. The deployment is self-hosted.

### Both PostgreSQL and MongoDB

Rejected, and it is the worst of the three options:

- **It splits the tenancy boundary.** Two enforcement mechanisms with different semantics for the one
  requirement identified as highest-risk. One will drift.
- **It breaks transactions across the seam.** Publishing an article writes article state *and*
  embeddings; resolving a conversation writes the cycle row *and* an event. Whichever pair straddles
  the seam becomes a distributed write with a half-failure mode to detect and repair.
- **It doubles the ops surface** on a deployment we operate ourselves. Two backup and restore
  procedures, two upgrade paths. Self-hosted MongoDB also needs a replica set even single-node, just
  for transactions and change streams.

### Weaviate as a separate vector store

Rejected. At a corpus of dozens to low hundreds of published articles per workspace, performance is
not the deciding factor. Three things are:

- **Tenancy.** Weaviate's multi-tenancy is a second mechanism to get right, outside the RLS boundary.
- **Retrieval is filtered, not pure-similarity.** The bot searches `workspace_id`, `state = 'published'`
  and `archived_at IS NULL`, often within one intent. In pgvector that is a `WHERE` clause on the same
  query; across a service boundary it is pre/post-filtering plus keeping Weaviate's copy of
  `published`/`archived` in sync. The spec is explicit that "an archived one the bot still knows about
  keeps being used" — two stores make that failure *possible*.
- **"Knowledge sync must be loud."** With pgvector, publishing an article and writing its embeddings
  is one transaction, so sync cannot half-fail. With Weaviate it is a distributed write — you would
  need the loud sync status *because* you chose Weaviate.

Weaviate earns its place at millions of vectors, or for out-of-the-box BM25+vector fusion. Neither
applies.

### In-process cosine similarity

Rejected. No persistence, reloaded on every process start, and every API replica holds its own copy —
so a manual re-sync only fixes one instance.

### Prisma instead of Drizzle

Rejected on three counts:

- **RLS needs session variables.** Every request runs `SET LOCAL app.workspace_id` inside its
  transaction. Drizzle's transaction API makes that a one-line wrapper; Prisma needs `$executeRaw`
  threaded through interactive transactions and loses the guarantee whenever someone forgets.
- **Reporting is SQL-shaped.** Drizzle's `sql` template keeps window functions and `FILTER` clauses
  typed and inline. Prisma pushes them to `$queryRaw`, outside the type system.
- **pgvector is a first-class column type** in Drizzle. Prisma models it as `Unsupported()`, which
  cannot be selected through the client.

## Consequences

### Positive

- Vector search available in the target deployment, with no second service.
- Tenant isolation enforced by the engine and testable at the SQL layer independently of the API.
- Reporting queries are ordinary SQL.
- Two containers total: Postgres and Redis.
- `ENUM` types make an invalid conversation status impossible rather than merely untested.

### Negative

- The written stack decision is reversed and three documents need correcting.
- Schema migrations are now a real step (`drizzle-kit`), where MongoDB allowed additive changes with
  no migration. This is a cost worth paying for the constraints, but it is a cost.
- Team familiarity, if the team is stronger on Mongo than on SQL. Mitigated by the schema being
  ordinary relational modelling with no exotic features beyond RLS and pgvector.

### Neutral

- Redis, BullMQ, Socket.io, object storage and the entire front-end stack are untouched.
- The domain model, conversation status machine, metric definitions, roles matrix and non-negotiables
  were never database-specific and survive unchanged.

## Cost of the reversal

Zero engineering cost. No code, schema or data exists. Three documents to correct:

1. `CLAUDE.md` — stack table, architecture diagram, "Server-side decisions" section
2. `README.md` — stack table, architecture block
3. This ADR

This was the last moment the switch was free.
