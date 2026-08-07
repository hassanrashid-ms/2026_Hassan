# ADR 002 — Weaviate over pgvector for article search

**Date:** 2026-08-07
**Status:** Accepted
**Reverses:** the "bot retrieval by pgvector" clause of [ADR 001](2026-08-04-postgresql-over-mongodb.md) —
does not reopen ADR 001's PostgreSQL/RLS/Drizzle decision, which stands.
**Full design:** [`../specs/2026-08-07-weaviate-faq-search-design.md`](../specs/2026-08-07-weaviate-faq-search-design.md)
**Implementation:** [`../plans/2026-08-07-weaviate-faq-search-implementation.md`](../plans/2026-08-07-weaviate-faq-search-implementation.md)

## Context

ADR 001 rejected Weaviate for article search, reasoning that at "dozens to low hundreds of published
articles per workspace," tenancy, filtered retrieval, and transactional sync all favored keeping
vectors in the same Postgres transaction as the article row.

That reasoning held while retrieval was pgvector cosine similarity over embeddings that were never
actually populated — `article_embedding` and `article_phrasing` shipped as schema-only scaffolding,
with no embedding pipeline ever wired up. Public article search ran on `ILIKE` against `title`/`body`
the entire time. The vector infrastructure was dead weight from day one.

Separately, ranked keyword search (BM25) was needed for `GET /articles` to be useful, and Postgres has
no built-in BM25 primitive — only `ILIKE` (no ranking) or `tsvector`/`ts_rank` (a real option, not
evaluated in ADR 001 because the discussion was framed as vector-vs-vector).

## Decision

**Weaviate Cloud, BM25 search, for public article search only.** Postgres remains the source of truth
for article content; Weaviate is purely a search/ranking index, kept in sync inline and
synchronously on publish/archive (same transaction — a Weaviate failure rolls back the Postgres write,
preserving ADR 001's "sync cannot half-fail" requirement without keeping the vectors in-database).

This drops the never-populated `article_phrasing`/`article_embedding` tables and the `pgvector`
extension entirely. `pgvector` is not reintroduced by this decision — the RLS/Postgres/Drizzle core of
ADR 001 is untouched.

## Why this doesn't repeat ADR 001's objections

- **Tenancy:** the `intentId` filter on the Weaviate query plus a Postgres re-fetch scoped by
  `workspace_id`/`state = 'published'` after ranking means Weaviate never has to be the tenancy
  boundary — Postgres RLS still is. Weaviate results that don't match a published, workspace-scoped
  row are dropped before they reach a response.
- **Sync cannot half-fail:** publish/archive call Weaviate inside the same `withWorkspace` transaction
  callback; throwing there rolls back the Postgres state change too.
- **Corpus size:** still true that pure-vector similarity isn't earned at this scale — this decision
  doesn't adopt vector search, it adopts BM25, which is the part of Weaviate's feature set that's
  actually being used. (Weaviate's `text2VecOpenAI` vectorizer is configured on the collection for a
  future RAG feature, per the design doc, but unused by this search path.)

## Alternatives considered

### Postgres full-text search (`tsvector` / `ts_rank`)

Rejected for this slice: no new external dependency, and it would have kept ADR 001's premise (search
lives next to the data) intact. Not chosen here because the design doc calls for BM25-quality ranking
with per-field weights (`title^3`, `keywords^2`, `body`) and this was scoped as the first slice of a
Weaviate integration that a later RAG feature will also depend on — standing up the Weaviate
collection once now avoids a second migration later.

### Reviving pgvector for embeddings-based search

Rejected. No embedding pipeline exists or is in scope; reviving the extension for unused columns was
the exact dead-weight problem this change removes.

## Consequences

### Positive

- Public article search gets real ranking (`title^3`, `keywords^2`, `body`) instead of unranked
  `ILIKE`.
- Dead scaffolding (`article_phrasing`, `article_embedding`, the `vector` extension) is gone.
- `pgvector` no longer needs to be mentioned as a dependency anywhere in current docs.

### Negative

- A second system (Weaviate Cloud) is now in the deployment, with its own credentials
  (`WEAVIATE_URL`/`WEAVIATE_API_KEY`) and its own availability — publish/archive now fail if Weaviate
  is unreachable, per the "fail together" design.
- `summary` is replaced by `keywords: string[]` across the article contract, touching every layer
  (schema, types, agent/surface backend, admin frontend, public surface).

### Neutral

- ADR 001's core decision (PostgreSQL, Drizzle, RLS) is unchanged — this ADR narrows scope to article
  search only.
