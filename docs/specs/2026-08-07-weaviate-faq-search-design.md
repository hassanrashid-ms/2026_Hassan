# Weaviate FAQ Search Migration — Design

## Summary

Replace the unused local pgvector/embedding setup with Weaviate Cloud as the search backend for the public FAQ/article search. Admin article authoring and the user-facing article experience stay functionally the same as today; only the search implementation underneath changes, plus two field changes (`summary` dropped, `keywords` added).

## Background

The `article` table already has `article_phrasing` and `article_embedding` sibling tables with a pgvector HNSW index, but nothing has ever written to them — no embedding generation exists in the codebase. Public search today is plain SQL `ILIKE` over `title`/`body`. This design replaces that dead pgvector scaffolding and the ILIKE search with Weaviate BM25, while keeping Postgres as the source of truth for article content.

## Data model changes

**`article` table** (`backend/src/shared/db/schema/articles.ts`):

- Drop `summary` column.
- Add `keywords`: `text[]`, not null, default `'{}'`.
- `id` (UUID) unchanged — used directly as the Weaviate object id.

**Dropped entirely:**

- `article_phrasing` table
- `article_embedding` table (and its pgvector HNSW index)
- `pgvector` extension declaration (`001_extensions.sql`)

**Data wipe:** no real production data exists yet, so the migration truncates the `article` table rather than backfilling `keywords` for existing rows.

## Weaviate collection

Collection `Article`, created via a one-off setup script (checked into the repo, run manually against the Weaviate Cloud instance — not run at app boot):

```python
from weaviate.classes.config import Configure, Property, DataType, Tokenization

client.collections.create(
    "Article",
    vector_config=Configure.Vectors.text2vec_openai(),
    properties=[
        Property(name="title", data_type=DataType.TEXT, tokenization=Tokenization.TRIGRAM),
        Property(name="body", data_type=DataType.TEXT, tokenization=Tokenization.TRIGRAM),
        Property(name="keywords", data_type=DataType.TEXT_ARRAY, tokenization=Tokenization.TRIGRAM),
        Property(name="intentId", data_type=DataType.TEXT, tokenization=Tokenization.FIELD,
                  skip_vectorization=True),
        Property(name="articleId", data_type=DataType.TEXT, tokenization=Tokenization.FIELD,
                  skip_vectorization=True),
    ],
)
```

- `title`/`body`/`keywords` use `TRIGRAM` tokenization (fuzzy/substring matching, and vectorized for future semantic use).
- `intentId`/`articleId` use `FIELD` tokenization (exact match, identifiers) and are excluded from vectorization.
- `vector_config` is set to `text2vec_openai` now so the collection is ready for near_text/hybrid search once a RAG feature needs it — no near_text/hybrid query is implemented in this slice. This requires an `OPENAI_API_KEY` configured on the Weaviate Cloud cluster itself (a cluster-level setting, not an app env var).
- The Weaviate object's own `id` is set to the article's UUID directly on insert, so `object.id == article.id`. `articleId` is also stored as a property for visibility in query results.
- Connection to Weaviate Cloud is via env vars (`WEAVIATE_URL`, `WEAVIATE_API_KEY`) to be provided separately.

## Sync flow (inline, synchronous)

- **Publish** (`agent/services/articlesService.ts` → `publishArticle`): after the Postgres state transition to `published` succeeds, upsert the Weaviate object (`id = article.id`, properties = `{title, body, keywords, intentId}`). If the Weaviate call fails, the publish fails too — Postgres and Weaviate are kept from silently diverging.
- **Archive** (`archiveArticle`): after the Postgres transition to `archived` succeeds, delete the object from Weaviate by id. Same fail-together behavior.
- **Draft create/update**: no Weaviate interaction. Published articles are immutable today (PATCH is draft-only), so there is no "edit a published article" case to sync.

## Search flow

**Public listing** (`surface/services/articlesService.ts` → `listPublicArticles`):

- Empty `q`: unchanged — Postgres query, `state = 'published'`, optional `intentId` filter, ordered by `published_at desc`. Weaviate is not involved.
- Non-empty `q`: call Weaviate BM25:
  ```python
  articles.query.bm25(
      query=q,
      query_properties=["title^3", "keywords^2", "body"],
      filters=Filter.by_property("intentId").equal(intentId) if intentId else None,
      limit=<page size>,
  )
  ```
  The returned ordered list of article UUIDs is used to fetch full rows from Postgres (`WHERE id IN (...) AND state = 'published'`), re-ordered to match Weaviate's ranking. Postgres remains the source of truth for the full article payload; Weaviate is purely the search/ranking index.
- `getPublicArticle` (single article fetch) is unchanged.

## Admin-side changes

- **Types** (`packages/types/src/articles.ts`): remove `summary` from `CreateArticleBody`/`UpdateArticleBody`; add `keywords: z.array(z.string()).optional()` (defaults to `[]`).
- **Backend** (`agent/services/articlesService.ts`, `agent/controllers/articlesController.ts`): accept and persist `keywords` on create/update; no summary handling anywhere.
- **Frontend** (`AdminArticles.tsx`, `agentApi.ts`): replace the summary field with a single free-text "Keywords" input (comma-separated). On submit, split on `,`, trim, drop empties, dedupe, send as `keywords: string[]`.

Keyword entry is manual for now. AI-generated keyword suggestions are explicitly out of scope for this slice (see Decisions).

## Cleanup / dead code removal

- Drop `article_phrasing`, `article_embedding`, their HNSW index, and the `pgvector` extension declaration.
- Remove `summary` column and every reference to it (backend types, controllers, services, frontend form/state/API calls).
- Remove all pgvector/`vector_cosine_ops` mentions from schema and SQL files.
- Update `docs/specs/2026-08-06-articles-knowledge-base-design.md` and any other doc/README/CLAUDE.md content mentioning pgvector, summary, `article_phrasing`, or `article_embedding` so nothing stale remains — pgvector should not be mentioned anywhere in the codebase or docs after this change.

## Testing

- Unit tests for `publishArticle`/`archiveArticle`: Weaviate call succeeds (object upserted/deleted); Weaviate call fails (Postgres state does not advance).
- Unit test for BM25 search path: correct `query_properties` weighting and `intentId` filter construction.
- Existing empty-`q` listing tests continue to pass unchanged.
- Weaviate client is mocked/stubbed in tests — no live calls to Weaviate Cloud from CI.
- Frontend: update `AdminArticles` form tests to cover the keywords input instead of summary.

## Decisions

- **pgvector → Weaviate**: the local pgvector/embedding tables were schema-only and never populated; rather than build embedding generation on top of dead scaffolding, search moves to Weaviate Cloud, which also gives BM25 keyword search out of the box.
- **summary dropped**: no code ever used the summary field for search or display beyond raw storage; keeping it added admin data-entry burden with no payoff, so it's removed rather than ported.
- **keywords manual for now, AI-generation deferred**: admins enter keywords by hand today (comma-separated free text). Auto-generating keyword suggestions via an LLM call (e.g. on create/publish) is a documented future enhancement, not built in this slice.
- **near_text/hybrid excluded, vectorizer pre-wired**: this slice ships BM25 only. The collection is configured with `text2vec_openai` vectorization on `title`/`body`/`keywords` so that when a RAG/semantic-search feature is built later, it's a query-level change (enabling near_text/hybrid) rather than a schema migration.
- **Sync is inline/synchronous, not queued**: publish/archive call Weaviate directly and await it, rather than going through the existing Redis job queue. This keeps Postgres and Weaviate from drifting silently; a failed Weaviate write fails the publish/archive request outright rather than leaving an inconsistent state to reconcile later.
- **Sync only on publish/archive**: matches existing behavior where drafts are never visible to public search and published articles are immutable (edits require draft state).
