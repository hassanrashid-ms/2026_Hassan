# Weaviate FAQ Search Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead pgvector/embedding scaffolding and ILIKE public search with Weaviate Cloud BM25 search, while swapping the `summary` field for `keywords` end to end.

**Architecture:** Nine vertically-sliced tasks, each independently shippable and testable: schema change → shared types → agent backend → surface backend (read models only) → frontend → Weaviate client plumbing → publish/archive sync → BM25 search swap → dead-code/doc cleanup. Postgres stays the source of truth for article content; Weaviate is purely the search/ranking index, kept in sync inline on publish/archive.

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, PostgreSQL 17, Zod, Vitest, React + TanStack Query, `weaviate-client` (official Weaviate TypeScript client).

## Global Constraints

- No hard deletes anywhere — this plan only ever drops *scaffolding* tables/columns that were never populated (`article_phrasing`, `article_embedding`, `summary`), never article content itself.
- `pgvector` must not be mentioned anywhere in the codebase or docs once this plan is complete.
- Weaviate collection is named `Article`; connection via `WEAVIATE_URL` / `WEAVIATE_API_KEY` env vars.
- Publish/archive Weaviate sync is inline and synchronous — if the Weaviate call fails, the Postgres transaction rolls back too (no BullMQ queue involved).
- `object.id == article.id` in Weaviate (the article's own UUID is the Weaviate object id).
- BM25 query properties are exactly `["title^3", "keywords^2", "body"]`.
- Every new API request/response shape change must stay registered in `backend/src/docs/openapi.ts` (per repo CLAUDE.md) — no task in this plan adds a new *endpoint*, so no new openapi registration is required, but double-check during Task 3/4/8 that existing registrations don't reference `summary`.
- Weaviate client calls in tests are always mocked/stubbed — never a live call to Weaviate Cloud from CI.

---

### Task 1: Drop `summary`, add `keywords`, remove pgvector scaffolding

**Files:**
- Modify: `backend/src/shared/db/schema/articles.ts`
- Modify: `backend/src/shared/db/sql/001_extensions.sql`
- Test: `backend/tests/agent.articles.test.ts` (existing test, used to confirm schema still boots)

**Interfaces:**
- Produces: `article.keywords: string[]` (Drizzle column `text[]`, not null, default `'{}'`) — every later task reads/writes this field. `article.summary` no longer exists. `articlePhrasing` and `articleEmbedding` exports no longer exist.

- [ ] **Step 1: Rewrite the schema file**

Replace the full contents of `backend/src/shared/db/schema/articles.ts`:

```typescript
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { articleState } from './enums.ts'
import { agent, workspace } from './identity.ts'
import { intent } from './taxonomy.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const article = pgTable('article', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  /** Nullable = uncategorized. Articles reference intent, never subintent. */
  intentId: uuid('intent_id').references(() => intent.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  keywords: text('keywords').array().notNull().default([]),
  state: articleState('state').notNull().default('draft'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => agent.id, { onDelete: 'restrict' }),
  publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** Schema-only in this slice — no upload endpoint, storage_key stays null. */
export const articleAttachment = pgTable('article_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  filename: text('filename').notNull(),
  storageKey: text('storage_key'),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})
```

This drops `articlePhrasing` and `articleEmbedding` entirely (and with them the `vector`/`index` imports and the HNSW index), drops `summary`, and adds `keywords`.

- [ ] **Step 2: Drop the pgvector extension declaration**

Replace the full contents of `backend/src/shared/db/sql/001_extensions.sql`:

```sql
-- citext backs agent.email. gen_random_uuid() is built in from Postgres 13, so
-- pgcrypto is not needed.
CREATE EXTENSION IF NOT EXISTS citext;
```

- [ ] **Step 3: Apply the schema change**

Run: `pnpm db:setup`

This truncates+re-pushes the schema (per the spec's data-wipe decision — no real production data exists yet) and drops the `vector` extension along with the two dead tables. Expected: command exits 0, no errors about dependent objects (the HNSW index and `article_embedding`/`article_phrasing` tables are dropped as part of the same push since they're no longer in the schema).

- [ ] **Step 4: Confirm existing article tests still run against the new schema**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts`
Expected: FAIL — `createArticle`/`updateArticle`/`toDetail` in `articlesService.ts` still reference `summary`, which no longer exists on the row type. This is expected; Task 3 fixes it. Confirm the failure is a TypeScript/property-shape error, not a raw SQL "column does not exist" error, which would mean Step 1's schema edit didn't take.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/db/schema/articles.ts backend/src/shared/db/sql/001_extensions.sql
git commit -m "feat(db): drop summary/pgvector scaffolding, add keywords to article"
```

---

### Task 2: Update shared `@support/types` contract

**Files:**
- Modify: `packages/types/src/articles.ts`
- Test: none dedicated (this package has no test suite today); verified via consuming packages' typechecks in later tasks.

**Interfaces:**
- Consumes: nothing new.
- Produces: `CreateArticleBody` / `UpdateArticleBody` now have `keywords: string[] optional` (defaults to `[]`) instead of `summary`. `AgentArticleDetail`, `PublicArticleSummary`, `PublicArticleDetail` now carry `keywords: string[]` instead of `summary: string | null`. These are the exact shapes Tasks 3–5 implement against.

- [ ] **Step 1: Edit the Zod request schemas**

In `packages/types/src/articles.ts`, replace:

```typescript
export const CreateArticleBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  summary: z.string().max(500).optional(),
  intent_id: z.uuid().optional(),
})

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  summary: z.string().max(500).nullable().optional(),
  intent_id: z.uuid().nullable().optional(),
})
```

with:

```typescript
export const CreateArticleBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().optional(),
})

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().nullable().optional(),
})
```

- [ ] **Step 2: Edit the response types**

Replace:

```typescript
export type AgentArticleDetail = {
  id: string
  title: string
  body: string
  summary: string | null
  state: ArticleStateValue
  intent_id: string | null
  created_by: string
  published_by: string | null
  published_at: string | null
  created_at: string
}

export type PublicArticleSummary = { id: string; title: string; summary: string | null; intent_id: string | null }
export type PublicArticlesResponse = { articles: PublicArticleSummary[] }
export type PublicArticleDetail = {
  id: string
  title: string
  body: string
  summary: string | null
  intent_id: string | null
  published_at: string | null
}
```

with:

```typescript
export type AgentArticleDetail = {
  id: string
  title: string
  body: string
  keywords: string[]
  state: ArticleStateValue
  intent_id: string | null
  created_by: string
  published_by: string | null
  published_at: string | null
  created_at: string
}

export type PublicArticleSummary = { id: string; title: string; keywords: string[]; intent_id: string | null }
export type PublicArticlesResponse = { articles: PublicArticleSummary[] }
export type PublicArticleDetail = {
  id: string
  title: string
  body: string
  keywords: string[]
  intent_id: string | null
  published_at: string | null
}
```

- [ ] **Step 3: Typecheck the types package**

Run: `pnpm --filter @support/types typecheck`
Expected: PASS (this file has no other internal references to `summary`).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/articles.ts
git commit -m "feat(types): replace summary with keywords in article contract"
```

---

### Task 3: Agent-side backend — create/update/get/list articles with `keywords`

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Modify: `backend/src/agent/controllers/articlesController.ts`
- Test: `backend/tests/agent.articles.test.ts`

**Interfaces:**
- Consumes: `article.keywords` (Task 1), `CreateArticleBody`/`UpdateArticleBody`/`AgentArticleDetail` (Task 2).
- Produces: `createArticle(ctx, { title, body, keywords?, intentId? })`, `updateArticle(ctx, id, { title?, body?, keywords?, intentId? })` — the exact input shapes Task 6's future edits (none) and the controller depend on. `toDetail()` now surfaces `keywords`.

- [ ] **Step 1: Write the failing test — create/update round-trip keywords**

Add to `backend/tests/agent.articles.test.ts` (inside the existing `describe('POST /articles')` block, as a new `it`):

```typescript
  it('persists keywords on create and update', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y', keywords: ['refund', 'billing'] })
      .expect(201)
    expect(created.body.keywords).toEqual(['refund', 'billing'])

    const patched = await request(app)
      .patch(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ keywords: ['refund'] })
      .expect(200)
    expect(patched.body.keywords).toEqual(['refund'])
  })

  it('defaults keywords to an empty array when omitted', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y' })
      .expect(201)
    expect(created.body.keywords).toEqual([])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts -t "keywords"`
Expected: FAIL — service/controller still reference `summary` and never read `keywords`, so the response body has no `keywords` field.

- [ ] **Step 3: Update the service**

In `backend/src/agent/services/articlesService.ts`:

Replace `toDetail`:

```typescript
function toDetail(row: typeof article.$inferSelect): AgentArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    keywords: row.keywords,
    state: row.state,
    intent_id: row.intentId,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  }
}
```

Replace `CreateArticleInput` and the insert in `createArticle`:

```typescript
export type CreateArticleInput = { title: string; body: string; keywords?: string[]; intentId?: string }
export type CreateArticleResult = { ok: true; article: AgentArticleDetail } | { ok: false; reason: 'intent_not_found' }

export async function createArticle(ctx: AgentContext, input: CreateArticleInput): Promise<CreateArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    if (input.intentId) {
      const [found] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, input.intentId)).limit(1)
      if (!found) return { ok: false, reason: 'intent_not_found' }
    }
    const [row] = await tx
      .insert(article)
      .values({
        workspaceId: ctx.workspaceId,
        intentId: input.intentId ?? null,
        title: input.title,
        body: input.body,
        keywords: input.keywords ?? [],
        createdBy: ctx.agentId,
      })
      .returning()
    return { ok: true, article: toDetail(row!) }
  })
}
```

Replace `UpdateArticleInput` and the patch in `updateArticle`:

```typescript
export type UpdateArticleInput = { title?: string; body?: string; keywords?: string[]; intentId?: string | null }
export type UpdateArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'intent_not_found' }

export async function updateArticle(ctx: AgentContext, id: string, patch: UpdateArticleInput): Promise<UpdateArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1)
    if (!existing) return { ok: false, reason: 'not_found' }
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' }
    if (patch.intentId) {
      const [found] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, patch.intentId)).limit(1)
      if (!found) return { ok: false, reason: 'intent_not_found' }
    }
    const [row] = await tx
      .update(article)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
        ...(patch.intentId !== undefined ? { intentId: patch.intentId } : {}),
      })
      .where(eq(article.id, id))
      .returning()
    return { ok: true, article: toDetail(row!) }
  })
}
```

`publishArticle` and `archiveArticle` are untouched in this task (Task 7 adds Weaviate sync to them) — they already call `toDetail`, which now returns `keywords` automatically.

- [ ] **Step 4: Update the controller**

In `backend/src/agent/controllers/articlesController.ts`, in `createArticleHandler` replace:

```typescript
  const result = await createArticle(req.agent!, {
    title: body.data.title,
    body: body.data.body,
    summary: body.data.summary,
    intentId: body.data.intent_id,
  })
```

with:

```typescript
  const result = await createArticle(req.agent!, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
    intentId: body.data.intent_id,
  })
```

In `updateArticleHandler` replace:

```typescript
  const result = await updateArticle(req.agent!, params.data.id, {
    title: body.data.title,
    body: body.data.body,
    summary: body.data.summary,
    intentId: body.data.intent_id,
  })
```

with:

```typescript
  const result = await updateArticle(req.agent!, params.data.id, {
    title: body.data.title,
    body: body.data.body,
    keywords: body.data.keywords,
    intentId: body.data.intent_id,
  })
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts`
Expected: PASS (all tests, including the two new ones and the pre-existing state-machine ones, which don't touch `keywords`/`summary` at all).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/src/agent/controllers/articlesController.ts backend/tests/agent.articles.test.ts
git commit -m "feat(agent): persist keywords instead of summary on articles"
```

---

### Task 4: Surface-side backend read models — drop `summary`, add `keywords`

**Files:**
- Modify: `backend/src/surface/services/articlesService.ts`
- Test: `backend/tests/surface.articles.test.ts`

**Interfaces:**
- Consumes: `article.keywords` (Task 1), `PublicArticleSummary`/`PublicArticleDetail` (Task 2).
- Produces: `toSummary`/`toDetail` now return `keywords: string[]`. `listPublicArticles`'s ILIKE-based `q` filtering is untouched in this task — Task 8 replaces it with the Weaviate BM25 call. This task only fixes the read-model shape so the surface package compiles and existing tests pass against the new column.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/surface.articles.test.ts`, inside `describe('GET /articles')`:

```typescript
  it('returns keywords on each summary', async () => {
    const { workspaceId, token } = await fixture()
    await ownerPool.query(
      `insert into agent (email, display_name) values ($1, 'A') returning id`,
      [`kw-${Math.random().toString(36).slice(2)}@example.test`],
    )
    const id = await seedArticle(workspaceId, { title: 'Refund policy' })
    await ownerPool.query(`update article set keywords = $1 where id = $2`, [['refund', 'billing'], id])

    const res = await request(app).get('/articles').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles[0].keywords).toEqual(['refund', 'billing'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- surface.articles.test.ts -t "keywords"`
Expected: FAIL — `toSummary` still returns `summary`, not `keywords`, so `res.body.articles[0].keywords` is `undefined`.

- [ ] **Step 3: Update the service**

In `backend/src/surface/services/articlesService.ts`, replace:

```typescript
function toSummary(row: typeof article.$inferSelect) {
  return { id: row.id, title: row.title, summary: row.summary, intent_id: row.intentId }
}

function toDetail(row: typeof article.$inferSelect): PublicArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    summary: row.summary,
    intent_id: row.intentId,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
  }
}
```

with:

```typescript
function toSummary(row: typeof article.$inferSelect) {
  return { id: row.id, title: row.title, keywords: row.keywords, intent_id: row.intentId }
}

function toDetail(row: typeof article.$inferSelect): PublicArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    keywords: row.keywords,
    intent_id: row.intentId,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
  }
}
```

Leave `listPublicArticles`'s `ilike(article.title, ...)`/`ilike(article.body, ...)` filtering exactly as-is — that's Task 8's job.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @support/api test -- surface.articles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/surface/services/articlesService.ts backend/tests/surface.articles.test.ts
git commit -m "feat(surface): expose keywords instead of summary on public article reads"
```

---

### Task 5: Frontend admin — replace Summary field with Keywords input

**Files:**
- Modify: `frontend/src/api/agentApi.ts`
- Modify: `frontend/src/pages/AdminArticles.tsx`
- Test: `frontend/src/pages/articleForm.test.ts` (extended with a keyword-parsing helper + its test)
- Create: none — the comma-split logic is small enough to colocate in `AdminArticles.tsx`, but per the "no placeholders" rule below the exact function is specified and unit-tested via a small exported helper in `articleForm.ts`.

**Interfaces:**
- Consumes: `AgentArticleDetail.keywords: string[]` (Task 2, already flows through `fetchArticle`/`fetchArticles` untouched — those functions are just typed passthroughs).
- Produces: `parseKeywordsInput(raw: string): string[]` in `frontend/src/pages/articleForm.ts` — splits on `,`, trims, drops empties, dedupes. `AdminArticles.tsx`'s draft state gains `keywordsInput: string` (the raw comma-separated text) instead of `summary: string`.

- [ ] **Step 1: Write the failing test for the parsing helper**

Add to `frontend/src/pages/articleForm.test.ts`:

```typescript
import { canEditFields, canPublish, parseKeywordsInput } from './articleForm.ts'

describe('parseKeywordsInput', () => {
  it('splits on commas, trims, drops empties, and dedupes', () => {
    expect(parseKeywordsInput('refund, billing ,, refund')).toEqual(['refund', 'billing'])
  })

  it('returns an empty array for blank input', () => {
    expect(parseKeywordsInput('   ')).toEqual([])
  })
})
```

(Replace the existing `import { canEditFields, canPublish } from './articleForm.ts'` line with the one above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/frontend test -- articleForm.test.ts`
Expected: FAIL — `parseKeywordsInput` is not exported from `articleForm.ts`.

- [ ] **Step 3: Implement the helper**

Add to `frontend/src/pages/articleForm.ts`:

```typescript
export function parseKeywordsInput(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed !== '') seen.add(trimmed)
  }
  return [...seen]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/frontend test -- articleForm.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the API client types**

In `frontend/src/api/agentApi.ts`, replace:

```typescript
export function createArticle(
  token: string,
  input: { title: string; body: string; summary?: string; intent_id?: string },
): Promise<AgentArticleDetail> {
  return apiCall('/agent/articles', token, { method: 'POST', body: JSON.stringify(input) })
}

export function updateArticle(
  token: string,
  id: string,
  patch: { title?: string; body?: string; summary?: string | null; intent_id?: string | null },
): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) })
}
```

with:

```typescript
export function createArticle(
  token: string,
  input: { title: string; body: string; keywords?: string[]; intent_id?: string },
): Promise<AgentArticleDetail> {
  return apiCall('/agent/articles', token, { method: 'POST', body: JSON.stringify(input) })
}

export function updateArticle(
  token: string,
  id: string,
  patch: { title?: string; body?: string; keywords?: string[]; intent_id?: string | null },
): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}`, token, { method: 'PATCH', body: JSON.stringify(patch) })
}
```

- [ ] **Step 6: Update `AdminArticles.tsx`**

Replace the import line to add the new helper:

```typescript
import { canEditFields, canPublish } from './articleForm.ts'
```

becomes:

```typescript
import { canEditFields, canPublish, parseKeywordsInput } from './articleForm.ts'
```

Replace the draft state declaration and its two initializers:

```typescript
  const [draft, setDraft] = useState<{ title: string; body: string; summary: string; intentId: string }>({
    title: '',
    body: '',
    summary: '',
    intentId: '',
  })
```

with:

```typescript
  const [draft, setDraft] = useState<{ title: string; body: string; keywordsInput: string; intentId: string }>({
    title: '',
    body: '',
    keywordsInput: '',
    intentId: '',
  })
```

Replace the `useEffect` that hydrates `draft` from `selected.data`:

```typescript
  useEffect(() => {
    if (selected.data) {
      setDraft({
        title: selected.data.title,
        body: selected.data.body,
        summary: selected.data.summary ?? '',
        intentId: selected.data.intent_id ?? '',
      })
    }
  }, [selected.data])
```

with:

```typescript
  useEffect(() => {
    if (selected.data) {
      setDraft({
        title: selected.data.title,
        body: selected.data.body,
        keywordsInput: selected.data.keywords.join(', '),
        intentId: selected.data.intent_id ?? '',
      })
    }
  }, [selected.data])
```

Replace the `createDraft` mutation body:

```typescript
      createArticle(session!.token, {
        title: draft.title,
        body: draft.body,
        summary: draft.summary || undefined,
        intent_id: draft.intentId || undefined,
      }),
```

with:

```typescript
      createArticle(session!.token, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || undefined,
      }),
```

Replace the `saveDraft` mutation body:

```typescript
      updateArticle(session!.token, selectedId!, {
        title: draft.title,
        body: draft.body,
        summary: draft.summary || null,
        intent_id: draft.intentId || null,
      }),
```

with:

```typescript
      updateArticle(session!.token, selectedId!, {
        title: draft.title,
        body: draft.body,
        keywords: parseKeywordsInput(draft.keywordsInput),
        intent_id: draft.intentId || null,
      }),
```

Replace the "+ New" button's reset:

```typescript
                onClick={() => {
                  setSelectedId(null)
                  setDraft({ title: '', body: '', summary: '', intentId: '' })
                }}
```

with:

```typescript
                onClick={() => {
                  setSelectedId(null)
                  setDraft({ title: '', body: '', keywordsInput: '', intentId: '' })
                }}
```

Replace the Summary form field:

```typescript
          <div>
            <label style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'block', marginBottom: '0.2rem' }}>Summary</label>
            <textarea
              placeholder="Short summary for search & preview"
              value={draft.summary}
              disabled={!editable}
              style={{ minHeight: '3.5rem' }}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
          </div>
```

with:

```typescript
          <div>
            <label style={{ fontSize: '0.8em', color: 'var(--muted)', display: 'block', marginBottom: '0.2rem' }}>Keywords</label>
            <input
              placeholder="refund, billing, cancel subscription"
              value={draft.keywordsInput}
              disabled={!editable}
              onChange={(e) => setDraft({ ...draft, keywordsInput: e.target.value })}
            />
          </div>
```

- [ ] **Step 7: Typecheck the frontend package**

Run: `pnpm --filter @support/frontend typecheck`
Expected: PASS — no remaining references to `summary` in `AdminArticles.tsx` or `agentApi.ts`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/api/agentApi.ts frontend/src/pages/AdminArticles.tsx frontend/src/pages/articleForm.ts frontend/src/pages/articleForm.test.ts
git commit -m "feat(frontend): replace summary field with keywords input in admin articles"
```

---

### Task 6: Weaviate client plumbing + one-off collection setup script

**Files:**
- Modify: `backend/src/env.ts`
- Modify: `backend/package.json` (add `weaviate-client` dependency)
- Create: `backend/src/shared/weaviate/client.ts`
- Create: `scripts/setup-weaviate-collection.ts`
- Test: `backend/tests/weaviateClient.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getWeaviateClient(): Promise<WeaviateClient>` from `backend/src/shared/weaviate/client.ts` — Task 7 and Task 8 both call this (indirectly, via the `articlesIndex.ts` module Task 7 creates). `getEnv().WEAVIATE_URL` / `getEnv().WEAVIATE_API_KEY` — new required env vars.

- [ ] **Step 1: Add the dependency**

In `backend/package.json`, add to `"dependencies"`:

```json
    "weaviate-client": "^3",
```

Run: `pnpm install`
Expected: lockfile updates, `node_modules/weaviate-client` exists.

- [ ] **Step 2: Add env vars**

In `backend/src/env.ts`, add to `EnvSchema` (after `REDIS_URL`):

```typescript
  WEAVIATE_URL: z.string().min(1, 'WEAVIATE_URL is required'),
  WEAVIATE_API_KEY: z.string().min(1, 'WEAVIATE_API_KEY is required'),
```

Add both to `.env.example` at the repo root with placeholder values (`WEAVIATE_URL=` / `WEAVIATE_API_KEY=`) — check `.env.example`'s existing format first and match it.

- [ ] **Step 3: Write the failing test for the client wrapper**

Create `backend/tests/weaviateClient.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

vi.mock('weaviate-client', () => {
  const connectToWeaviateCloud = vi.fn().mockResolvedValue({ collections: { get: vi.fn() } })
  return { default: { connectToWeaviateCloud, ApiKey: vi.fn() } }
})

describe('getWeaviateClient', () => {
  it('memoises the connection across calls', async () => {
    const { getWeaviateClient } = await import('../src/shared/weaviate/client.ts')
    const weaviate = (await import('weaviate-client')).default

    const first = await getWeaviateClient()
    const second = await getWeaviateClient()

    expect(first).toBe(second)
    expect(weaviate.connectToWeaviateCloud).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- weaviateClient.test.ts`
Expected: FAIL — `backend/src/shared/weaviate/client.ts` does not exist yet.

- [ ] **Step 5: Implement the client wrapper**

Create `backend/src/shared/weaviate/client.ts`:

```typescript
import weaviate, { type WeaviateClient } from 'weaviate-client'
import { getEnv } from '../../env.ts'

let client: WeaviateClient | undefined

/** Memoised so repeated calls in the same process reuse one connection. */
export async function getWeaviateClient(): Promise<WeaviateClient> {
  if (!client) {
    client = await weaviate.connectToWeaviateCloud(getEnv().WEAVIATE_URL, {
      authCredentials: new weaviate.ApiKey(getEnv().WEAVIATE_API_KEY),
    })
  }
  return client
}

/** Tests only — forces the next getWeaviateClient() call to reconnect. */
export function resetWeaviateClientCache(): void {
  client = undefined
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @support/api test -- weaviateClient.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the one-off collection setup script**

Create `scripts/setup-weaviate-collection.ts` (run manually against Weaviate Cloud — never at app boot, per the design doc):

```typescript
import weaviate from 'weaviate-client'
import { Configure, DataType, Tokenization } from 'weaviate-client'

async function main() {
  const url = process.env.WEAVIATE_URL
  const apiKey = process.env.WEAVIATE_API_KEY
  if (!url || !apiKey) {
    throw new Error('WEAVIATE_URL and WEAVIATE_API_KEY must be set in the environment.')
  }

  const client = await weaviate.connectToWeaviateCloud(url, { authCredentials: new weaviate.ApiKey(apiKey) })

  await client.collections.create({
    name: 'Article',
    vectorizers: Configure.Vectorizer.text2VecOpenAI(),
    properties: [
      { name: 'title', dataType: DataType.TEXT, tokenization: Tokenization.TRIGRAM },
      { name: 'body', dataType: DataType.TEXT, tokenization: Tokenization.TRIGRAM },
      { name: 'keywords', dataType: DataType.TEXT_ARRAY, tokenization: Tokenization.TRIGRAM },
      { name: 'intentId', dataType: DataType.TEXT, tokenization: Tokenization.FIELD, skipVectorization: true },
      { name: 'articleId', dataType: DataType.TEXT, tokenization: Tokenization.FIELD, skipVectorization: true },
    ],
  })

  console.log('Created "Article" collection in Weaviate Cloud.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
```

Note in a comment at the top of the file: this requires `OPENAI_API_KEY` configured on the Weaviate Cloud cluster itself (a cluster-level setting, not an app env var) for the `text2VecOpenAI` vectorizer to function — per the design doc, this is pre-wired for a future RAG feature and unused by BM25 search in this slice.

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @support/api typecheck`
Expected: PASS. (The setup script lives outside `backend/`, so also run `pnpm exec tsc --noEmit scripts/setup-weaviate-collection.ts --moduleResolution bundler --module esnext --target es2022` if the root has no tsconfig covering `scripts/` — check `scripts/verify-seam.sh`'s sibling files first for the existing convention before adding a new typecheck step; if `scripts/` isn't typechecked anywhere today, skip this and rely on `pnpm dev`-time execution to catch errors.)

- [ ] **Step 9: Commit**

```bash
git add backend/package.json pnpm-lock.yaml backend/src/env.ts backend/src/shared/weaviate/client.ts backend/tests/weaviateClient.test.ts scripts/setup-weaviate-collection.ts .env.example
git commit -m "feat(weaviate): add client wrapper, env vars, and collection setup script"
```

---

### Task 7: Publish/archive Weaviate sync

**Files:**
- Create: `backend/src/shared/weaviate/articlesIndex.ts`
- Modify: `backend/src/agent/services/articlesService.ts`
- Test: `backend/tests/weaviateArticlesIndex.test.ts`
- Test: `backend/tests/agent.articles.test.ts` (extended)

**Interfaces:**
- Consumes: `getWeaviateClient` (Task 6).
- Produces: `upsertArticleObject(input: { id: string; title: string; body: string; keywords: string[]; intentId: string | null }): Promise<void>` and `deleteArticleObject(id: string): Promise<void>` from `backend/src/shared/weaviate/articlesIndex.ts` — Task 8's search path also imports this module's collection-access pattern.

- [ ] **Step 1: Write the failing test for the index module**

Create `backend/tests/weaviateArticlesIndex.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insert = vi.fn()
const replace = vi.fn()
const deleteById = vi.fn()
const exists = vi.fn()
const collectionsGet = vi.fn(() => ({ data: { insert, replace, deleteById, exists } }))

vi.mock('../src/shared/weaviate/client.ts', () => ({
  getWeaviateClient: vi.fn().mockResolvedValue({ collections: { get: collectionsGet } }),
}))

beforeEach(() => {
  insert.mockReset()
  replace.mockReset()
  deleteById.mockReset()
  exists.mockReset()
})

describe('upsertArticleObject', () => {
  it('inserts a new object when it does not already exist', async () => {
    const { upsertArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockResolvedValue(false)

    await upsertArticleObject({ id: 'a1', title: 'T', body: 'B', keywords: ['k'], intentId: 'i1' })

    expect(collectionsGet).toHaveBeenCalledWith('Article')
    expect(insert).toHaveBeenCalledWith({
      id: 'a1',
      properties: { title: 'T', body: 'B', keywords: ['k'], intentId: 'i1', articleId: 'a1' },
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('replaces an existing object', async () => {
    const { upsertArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')
    exists.mockResolvedValue(true)

    await upsertArticleObject({ id: 'a1', title: 'T2', body: 'B2', keywords: [], intentId: null })

    expect(replace).toHaveBeenCalledWith('a1', {
      properties: { title: 'T2', body: 'B2', keywords: [], intentId: '', articleId: 'a1' },
    })
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('deleteArticleObject', () => {
  it('deletes the object by id', async () => {
    const { deleteArticleObject } = await import('../src/shared/weaviate/articlesIndex.ts')

    await deleteArticleObject('a1')

    expect(deleteById).toHaveBeenCalledWith('a1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- weaviateArticlesIndex.test.ts`
Expected: FAIL — `backend/src/shared/weaviate/articlesIndex.ts` does not exist.

- [ ] **Step 3: Implement the index module**

Create `backend/src/shared/weaviate/articlesIndex.ts`:

```typescript
import { getWeaviateClient } from './client.ts'

export type ArticleIndexInput = { id: string; title: string; body: string; keywords: string[]; intentId: string | null }

async function getArticleCollection() {
  const client = await getWeaviateClient()
  return client.collections.get('Article')
}

/** Weaviate's own object id is set to the article's UUID, per the design doc. */
export async function upsertArticleObject(input: ArticleIndexInput): Promise<void> {
  const collection = await getArticleCollection()
  const properties = {
    title: input.title,
    body: input.body,
    keywords: input.keywords,
    intentId: input.intentId ?? '',
    articleId: input.id,
  }
  const alreadyExists = await collection.data.exists(input.id)
  if (alreadyExists) {
    await collection.data.replace(input.id, { properties })
  } else {
    await collection.data.insert({ id: input.id, properties })
  }
}

export async function deleteArticleObject(id: string): Promise<void> {
  const collection = await getArticleCollection()
  await collection.data.deleteById(id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test -- weaviateArticlesIndex.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for publish/archive sync**

Add to `backend/tests/agent.articles.test.ts`, near the top (after the existing imports), add a mock:

```typescript
import { deleteArticleObject, upsertArticleObject } from '../src/shared/weaviate/articlesIndex.ts'

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  upsertArticleObject: vi.fn().mockResolvedValue(undefined),
  deleteArticleObject: vi.fn().mockResolvedValue(undefined),
}))
```

Also add `import { vi } from 'vitest'` to the existing `vitest` import line (`import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'`), and reset the mocks in the existing `beforeEach(truncateAll)` — change it to:

```typescript
beforeEach(async () => {
  await truncateAll()
  vi.mocked(upsertArticleObject).mockClear()
  vi.mocked(deleteArticleObject).mockClear()
})
```

Then extend `describe('draft -> publish -> archive', ...)` with two new `it` blocks:

```typescript
  it('upserts the Weaviate object on publish and deletes it on archive', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y', keywords: ['k'] })
      .expect(201)
    const id = created.body.id as string

    await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(upsertArticleObject).toHaveBeenCalledWith(
      expect.objectContaining({ id, title: 'X', body: 'Y', keywords: ['k'] }),
    )

    await request(app).post(`/articles/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(deleteArticleObject).toHaveBeenCalledWith(id)
  })

  it('does not advance state when the Weaviate publish call fails', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)
    vi.mocked(upsertArticleObject).mockRejectedValueOnce(new Error('weaviate unreachable'))

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y' })
      .expect(201)
    const id = created.body.id as string

    await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(500)

    const { rows } = await ownerPool.query<{ state: string }>(`select state from article where id = $1`, [id])
    expect(rows[0]!.state).toBe('draft')
  })
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts -t "Weaviate"`
Expected: FAIL — `publishArticle`/`archiveArticle` don't call `upsertArticleObject`/`deleteArticleObject` yet.

- [ ] **Step 7: Wire the sync calls into the service**

In `backend/src/agent/services/articlesService.ts`, add the import:

```typescript
import { deleteArticleObject, upsertArticleObject } from '../../shared/weaviate/articlesIndex.ts'
```

Replace `publishArticle`:

```typescript
export async function publishArticle(ctx: AgentContext, id: string): Promise<PublishArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1)
    if (!existing) return { ok: false, reason: 'not_found' }
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' }
    if (existing.title.trim() === '' || existing.body.trim() === '') return { ok: false, reason: 'empty_fields' }
    const [row] = await tx
      .update(article)
      .set({ state: 'published', publishedBy: ctx.agentId, publishedAt: new Date() })
      .where(eq(article.id, id))
      .returning()
    await upsertArticleObject({
      id: row!.id,
      title: row!.title,
      body: row!.body,
      keywords: row!.keywords,
      intentId: row!.intentId,
    })
    return { ok: true, article: toDetail(row!) }
  })
}
```

Replace `archiveArticle`:

```typescript
export async function archiveArticle(ctx: AgentContext, id: string): Promise<ArchiveArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.update(article).set({ state: 'archived' }).where(eq(article.id, id)).returning()
    if (!row) return { ok: false, reason: 'not_found' }
    await deleteArticleObject(row.id)
    return { ok: true, article: toDetail(row) }
  })
}
```

Throwing inside the `withWorkspace` callback rolls back the enclosing Postgres transaction (`db.transaction`), so a Weaviate failure and a Postgres state advance can never diverge — this satisfies the design doc's "fail together" requirement without any extra try/catch.

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts weaviateArticlesIndex.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/shared/weaviate/articlesIndex.ts backend/src/agent/services/articlesService.ts backend/tests/weaviateArticlesIndex.test.ts backend/tests/agent.articles.test.ts
git commit -m "feat(agent): sync publish/archive to Weaviate inline, fail-together"
```

---

### Task 8: Public search — swap ILIKE for Weaviate BM25

**Files:**
- Modify: `backend/src/shared/weaviate/articlesIndex.ts`
- Modify: `backend/src/surface/services/articlesService.ts`
- Test: `backend/tests/weaviateArticlesIndex.test.ts` (extended)
- Test: `backend/tests/surface.articles.test.ts` (extended)

**Interfaces:**
- Consumes: `getWeaviateClient` (Task 6), `article` schema (Task 1).
- Produces: `searchArticleIds(query: string, opts: { intentId?: string; limit: number }): Promise<string[]>` from `articlesIndex.ts` — returns Weaviate's ranked list of article UUIDs; `listPublicArticles` uses it to re-order the Postgres rows it fetches.

- [ ] **Step 1: Write the failing test for the search function**

Add to `backend/tests/weaviateArticlesIndex.test.ts`:

```typescript
const bm25 = vi.fn()
```

Update the top-level mock to include `query: { bm25 }` on the returned collection object:

```typescript
const collectionsGet = vi.fn(() => ({ data: { insert, replace, deleteById, exists }, query: { bm25 } }))
```

Add `bm25.mockReset()` to the `beforeEach`.

Add a new `describe` block:

```typescript
describe('searchArticleIds', () => {
  it('queries BM25 with weighted properties and returns ranked article ids', async () => {
    const { searchArticleIds } = await import('../src/shared/weaviate/articlesIndex.ts')
    bm25.mockResolvedValue({ objects: [{ properties: { articleId: 'a2' } }, { properties: { articleId: 'a1' } }] })

    const ids = await searchArticleIds('refund', { intentId: 'i1', limit: 20 })

    expect(bm25).toHaveBeenCalledWith('refund', expect.objectContaining({
      queryProperties: ['title^3', 'keywords^2', 'body'],
      limit: 20,
    }))
    expect(ids).toEqual(['a2', 'a1'])
  })

  it('omits the filter when no intentId is given', async () => {
    const { searchArticleIds } = await import('../src/shared/weaviate/articlesIndex.ts')
    bm25.mockResolvedValue({ objects: [] })

    await searchArticleIds('refund', { limit: 20 })

    expect(bm25).toHaveBeenCalledWith('refund', expect.objectContaining({ filters: undefined }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- weaviateArticlesIndex.test.ts -t "searchArticleIds"`
Expected: FAIL — `searchArticleIds` is not exported.

- [ ] **Step 3: Implement `searchArticleIds`**

Add to `backend/src/shared/weaviate/articlesIndex.ts`:

```typescript
import { Filter } from 'weaviate-client'

export async function searchArticleIds(query: string, opts: { intentId?: string; limit: number }): Promise<string[]> {
  const collection = await getArticleCollection()
  const result = await collection.query.bm25(query, {
    queryProperties: ['title^3', 'keywords^2', 'body'],
    filters: opts.intentId ? collection.filter.byProperty('intentId').equal(opts.intentId) : undefined,
    limit: opts.limit,
    returnProperties: ['articleId'],
  })
  return result.objects.map((o: { properties: { articleId: string } }) => o.properties.articleId)
}
```

(`Filter` import is unused directly here since filtering goes through `collection.filter`, matching the pattern the test mocks — remove the `import { Filter } from 'weaviate-client'` line if your installed `weaviate-client` version exposes filtering only via `collection.filter.byProperty(...)`, which is what this implementation and its test assume. Confirm against the installed package's type defs before finalizing; if the API differs, adjust the call while keeping the exported signature `searchArticleIds(query, opts): Promise<string[]>` unchanged, since Step 5 depends on that exact signature.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @support/api test -- weaviateArticlesIndex.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the surface search swap**

Add to `backend/tests/surface.articles.test.ts`, near the top:

```typescript
import { vi } from 'vitest'
import { searchArticleIds } from '../src/shared/weaviate/articlesIndex.ts'

vi.mock('../src/shared/weaviate/articlesIndex.ts', () => ({
  searchArticleIds: vi.fn(),
}))
```

Replace the existing keyword test:

```typescript
  it('filters by keyword across title and body', async () => {
    const { workspaceId, token } = await fixture()
    await seedArticle(workspaceId, { title: 'Refund policy', body: 'We refund within 30 days.' })
    await seedArticle(workspaceId, { title: 'Password reset', body: 'Tap reset.' })

    const res = await request(app).get('/articles').query({ q: 'refund' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toHaveLength(1)
    expect(res.body.articles[0].title).toBe('Refund policy')
  })
```

with:

```typescript
  it('ranks results using Weaviate BM25 order, not Postgres insertion order', async () => {
    const { workspaceId, token } = await fixture()
    const idA = await seedArticle(workspaceId, { title: 'Refund policy', body: 'We refund within 30 days.' })
    const idB = await seedArticle(workspaceId, { title: 'Password reset', body: 'Tap reset.' })
    vi.mocked(searchArticleIds).mockResolvedValue([idB, idA])

    const res = await request(app).get('/articles').query({ q: 'reset refund' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(searchArticleIds).toHaveBeenCalledWith('reset refund', { intentId: undefined, limit: expect.any(Number) })
    expect(res.body.articles.map((a: { id: string }) => a.id)).toEqual([idB, idA])
  })

  it('excludes ids Weaviate returns that are not published', async () => {
    const { workspaceId, token } = await fixture()
    const published = await seedArticle(workspaceId, { title: 'Refund policy', state: 'published' })
    const draft = await seedArticle(workspaceId, { title: 'Draft refund note', state: 'draft' })
    vi.mocked(searchArticleIds).mockResolvedValue([draft, published])

    const res = await request(app).get('/articles').query({ q: 'refund' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles.map((a: { id: string }) => a.id)).toEqual([published])
  })
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @support/api test -- surface.articles.test.ts -t "BM25"`
Expected: FAIL — `listPublicArticles` still does its own ILIKE filtering and never calls `searchArticleIds`.

- [ ] **Step 7: Swap the search implementation**

In `backend/src/surface/services/articlesService.ts`, replace the imports:

```typescript
import { and, desc, eq, ilike, or } from 'drizzle-orm'
import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types'
import { article } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'
```

with:

```typescript
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types'
import { article } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'
import { searchArticleIds } from '../../shared/weaviate/articlesIndex.ts'
```

Replace `listPublicArticles`:

```typescript
export async function listPublicArticles(
  ctx: PlayerContext,
  filter: { intentId?: string; q?: string },
): Promise<PublicArticlesResponse> {
  if (filter.q) {
    const rankedIds = await searchArticleIds(filter.q, { intentId: filter.intentId, limit: 50 })
    if (rankedIds.length === 0) return { articles: [] }
    return withWorkspace(ctx.workspaceId, async (tx) => {
      const rows = await tx
        .select()
        .from(article)
        .where(and(eq(article.state, 'published'), inArray(article.id, rankedIds)))
      const byId = new Map(rows.map((r) => [r.id, r]))
      const ordered = rankedIds.map((id) => byId.get(id)).filter((r): r is typeof article.$inferSelect => r !== undefined)
      return { articles: ordered.map(toSummary) }
    })
  }
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const conditions = [eq(article.state, 'published')]
    if (filter.intentId) conditions.push(eq(article.intentId, filter.intentId))
    const rows = await tx
      .select()
      .from(article)
      .where(and(...conditions))
      .orderBy(desc(article.publishedAt))
    return { articles: rows.map(toSummary) }
  })
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter @support/api test -- surface.articles.test.ts weaviateArticlesIndex.test.ts`
Expected: PASS. Also confirm the pre-existing "returns an empty list, never an error, when nothing matches" test still passes: with `searchArticleIds` mocked and no explicit `mockResolvedValue` for that test, it returns `undefined` by default in vitest's `vi.fn()` — set a default resolved value in `beforeEach` (`vi.mocked(searchArticleIds).mockResolvedValue([])`) so untouched tests in this file keep passing without every one of them stubbing the mock individually.

- [ ] **Step 9: Add the default mock and re-run the full surface suite**

In `backend/tests/surface.articles.test.ts`, add a `beforeEach`:

```typescript
beforeEach(() => {
  vi.mocked(searchArticleIds).mockResolvedValue([])
})
```

placed alongside the existing `beforeEach(truncateAll)` (both run; order doesn't matter since they touch different state).

Run: `pnpm --filter @support/api test -- surface.articles.test.ts`
Expected: PASS, full file.

- [ ] **Step 10: Commit**

```bash
git add backend/src/shared/weaviate/articlesIndex.ts backend/src/surface/services/articlesService.ts backend/tests/weaviateArticlesIndex.test.ts backend/tests/surface.articles.test.ts
git commit -m "feat(surface): search public articles via Weaviate BM25 instead of ILIKE"
```

---

### Task 9: Dead-code and documentation cleanup

**Files:**
- Modify: `docs/specs/2026-08-06-articles-knowledge-base-design.md`
- Modify: any other doc/README/CLAUDE.md content mentioning `pgvector`, `summary` (article field), `article_phrasing`, or `article_embedding`
- Modify: `CLAUDE.md` (Stack table currently lists `PostgreSQL 17 (pgvector/pgvector:pg17)` and `Bot retrieval | pgvector, HNSW index`)

**Interfaces:**
- Consumes: nothing new — this is a documentation-only pass verifying Tasks 1–8 left no stale references.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Grep for every remaining stale reference**

Run:
```bash
grep -rniE 'pgvector|article_phrasing|article_embedding|hnsw|vector_cosine_ops' --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.md' . 2>/dev/null
```
Expected: matches only inside `docs/specs/2026-08-06-articles-knowledge-base-design.md`, `CLAUDE.md`, and possibly `docker-compose.yml` (the `pgvector/pgvector:pg17` Postgres image — this is a real infra dependency providing `citext`-adjacent functionality is NOT it; check whether `pgvector/pgvector:pg17` is still needed for anything else in the image, e.g. if it's just the base Postgres 17 image with the extension pre-installed, switching to plain `postgres:17` is in scope too since Task 1 dropped the `vector` extension entirely).

- [ ] **Step 2: Update `docs/specs/2026-08-06-articles-knowledge-base-design.md`**

Read the file, find every section describing `summary`, `article_phrasing`, `article_embedding`, or pgvector, and either remove those sections or replace them with a pointer: "Superseded by `docs/specs/2026-08-07-weaviate-faq-search-design.md` — see that doc for the current article search/data model." Do not leave the old field/table descriptions in place, since the instruction is that pgvector must not be mentioned anywhere after this change.

- [ ] **Step 3: Update `CLAUDE.md`**

In the `## Stack` table, replace:

```
| Database | PostgreSQL 17 (`pgvector/pgvector:pg17`) — self-hosted, Docker |
```

with:

```
| Database | PostgreSQL 17 — self-hosted, Docker |
```

(Only if Step 1 confirms nothing else in the compose file depends on the `pgvector/pgvector:pg17` image variant specifically — check `docker-compose.yml` for the actual image tag in use and update it to a plain `postgres:17` image tag in the same edit if so.)

Replace:

```
| Bot retrieval | pgvector, HNSW index — same database |
```

with:

```
| Bot retrieval | Weaviate Cloud, BM25 (see `docs/specs/2026-08-07-weaviate-faq-search-design.md`) |
```

- [ ] **Step 4: Re-run the grep to confirm the sweep is complete**

Run:
```bash
grep -rniE 'pgvector|article_phrasing|article_embedding|hnsw|vector_cosine_ops' --include='*.ts' --include='*.tsx' --include='*.sql' --include='*.md' --include='*.yml' . 2>/dev/null
```
Expected: no output.

- [ ] **Step 5: Full-repo verification**

Run: `pnpm typecheck && pnpm test`
Expected: PASS across every package — this is the final gate confirming Tasks 1–9 leave the repo in a consistent, fully-migrated state.

- [ ] **Step 6: Commit**

```bash
git add docs/specs/2026-08-06-articles-knowledge-base-design.md CLAUDE.md docker-compose.yml
git commit -m "docs: remove stale pgvector/summary references after Weaviate migration"
```

---

## Self-Review Notes

- **Spec coverage:** Data model changes → Task 1. Weaviate collection → Task 6. Sync flow → Task 7. Search flow → Task 8. Admin-side changes → Tasks 2, 3, 5. Cleanup → Task 9. Testing requirements (unit tests for publish/archive success/failure, BM25 query_properties/filter construction, unchanged empty-`q` tests, mocked Weaviate client, frontend keywords form tests) are each covered in Tasks 3, 5, 7, 8.
- **Deferred judgment calls flagged inline, not hidden:** Task 8 Step 3 and Task 6 Step 8 flag two spots where the exact `weaviate-client` v3 API surface (filter construction, scripts/ typecheck coverage) should be confirmed against the installed package version before finalizing — these are genuine unknowns (the design doc's collection-creation code is Python, translated to TypeScript here) rather than placeholders for missing logic.
