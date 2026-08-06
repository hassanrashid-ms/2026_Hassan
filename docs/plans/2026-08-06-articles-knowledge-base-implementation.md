# Articles Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a basic knowledge base — agents author/publish articles from the console, players read published articles on an unauthenticated public page — per `docs/specs/2026-08-06-articles-knowledge-base-design.md`.

**Architecture:** Two new Drizzle-backed table groups (`intent`/`subintent` taxonomy, `article`/`article_phrasing`/`article_embedding`/`article_attachment` knowledge), RLS auto-applied by the existing `002_rls.sql` generator. Two vertical backend slices — agent console (taxonomy admin-only create + article draft/publish/archive CRUD) and public surface (search/read) — that touch disjoint route files and can be built in parallel once the schema lands. Two vertical frontend slices follow the same split.

**Tech Stack:** Express 5 + Zod + Drizzle ORM (existing), Postgres 17 + pgvector, Vitest + supertest, React 19 + TanStack Query + react-router-dom (existing, no new frontend libraries — this codebase has no Tailwind/shadcn installed despite CLAUDE.md's aspirational stack table; follow the actual plain-CSS/vanilla-component pattern in `AgentInbox.tsx`).

## Global Constraints

- Every scoped table (has `workspace_id`) gets RLS automatically from `backend/src/shared/db/sql/002_rls.sql` — do not hand-write policies.
- Every FK uses `onDelete: 'restrict'` — `backend/tests/schema.test.ts`'s `'restricts every delete rather than cascading'` test asserts this for **every** FK in the database, not just new ones.
- No hard-delete routes, ever. Removing an article means `state → archived`.
- RLS violations and "not yours" cases are `404`, never `403`. `403` (`forbidden`) is reserved for the admin-role check, which is a permission check, not a tenancy check.
- Every new endpoint gets a Zod schema in `packages/types/src/articles.ts` and a `registry.registerPath(...)` in `backend/src/docs/openapi.ts` — not a follow-up.
- Permission checks run at the API (`requireAdminRole` middleware), never only hidden in the console UI.
- Any client-supplied id used as a FK (e.g. `intent_id` on an article) must be confirmed visible with an explicit scoped `SELECT` before use — RLS makes another workspace's row invisible, not absent, so this SELECT is what turns a bad reference into a `404`.
- `withWorkspace(workspaceId, fn)` is the only way to touch a scoped table; never query scoped tables outside it.
- Backend tests need Postgres up (`pnpm dev` starts Docker services) and run with `pnpm --filter @support/api test`.
- Frontend has no component-rendering test setup (no jsdom/@testing-library) — this plan's frontend tests follow the existing convention (`src/boot.test.ts`) of testing extracted pure logic with plain Vitest, not rendering.

## Architectural note on public-route auth (read before Task 3)

The spec's Frontend section says `ArticleList.tsx`/`ArticleView.tsx` are called with "no auth header attached," while its API section says these routes resolve `app.workspace_id` "from the surface's existing workspace-routing (same as other unauthenticated surface endpoints)." No headerless/tokenless workspace-resolution mechanism exists anywhere in this codebase today — every existing `/surface/*` route (`bootstrap`, `article_read`, messages) resolves `workspace_id` from the player JWT via `requirePlayerToken`, and `surfaceRouter.use(requirePlayerToken)` is applied to the whole router. Building a second, novel, slug-based anonymous-workspace-resolution path is a materially bigger and riskier change than this slice's scope ("basic knowledge base") calls for, and nothing elsewhere in the spec asks for a public web knowledge base reachable outside a player's webview session.

**Decision for this plan:** treat "unauthenticated" as *relative to agent login* (same sense the API surface table uses it: no `requireAgentSession`), and mount the new public article routes under the existing `surfaceRouter`, inheriting `requirePlayerToken`. The frontend's `articlesApi.ts` passes the player token exactly like `surfaceApi.ts` already does. If this reading is wrong, revisit Task 3 and Task 5 only — nothing in Task 1, 2, or 4 depends on it.

---

## File Structure

**Backend — schema & shared contract (Task 1):**
- `backend/src/shared/db/schema/taxonomy.ts` — new: `intent`, `subintent`
- `backend/src/shared/db/schema/articles.ts` — new: `article`, `articlePhrasing`, `articleEmbedding`, `articleAttachment`
- `backend/src/shared/db/schema/enums.ts` — modify: add `articleState`
- `backend/src/shared/db/schema/index.ts` — modify: barrel-export the two new files
- `backend/src/shared/db/sql/001_extensions.sql` — modify: add `CREATE EXTENSION IF NOT EXISTS vector;`
- `packages/types/src/articles.ts` — new: every Zod schema and response type both backend slices and both frontend slices import
- `packages/types/src/index.ts` — modify: barrel-export `articles.ts`
- `backend/tests/schema.test.ts` — modify: extend `EXPECTED_TABLES` with the six new tables

**Backend — agent console slice (Task 2, parallel with Task 3):**
- `backend/src/shared/middleware/requireAdminRole.ts` — new
- `backend/src/agent/services/taxonomyService.ts`, `backend/src/agent/controllers/taxonomyController.ts`, `backend/src/agent/routers/taxonomyRouter.ts` — new
- `backend/src/agent/services/articlesService.ts`, `backend/src/agent/controllers/articlesController.ts`, `backend/src/agent/routers/articlesRouter.ts` — new
- `backend/src/agent/router.ts` — modify: mount both new routers
- `backend/src/docs/openapi.ts` — modify: register the five new agent paths
- `backend/tests/agent.taxonomy.test.ts`, `backend/tests/agent.articles.test.ts` — new

**Backend — public surface slice (Task 3, parallel with Task 2):**
- `backend/src/surface/services/articlesService.ts`, `backend/src/surface/controllers/articlesController.ts`, `backend/src/surface/routers/articlesRouter.ts` — new
- `backend/src/surface/router.ts` — modify: mount the new router
- `backend/src/docs/openapi.ts` — modify: register the two new public paths
- `backend/tests/surface.articles.test.ts` — new

**Frontend — agent console slice (Task 4, depends on Task 2):**
- `frontend/src/pages/AdminArticles.tsx` — new
- `frontend/src/pages/articleForm.ts` — new: pure validation/state-transition helpers, unit-tested
- `frontend/src/pages/articleForm.test.ts` — new
- `frontend/src/api/agentApi.ts` — modify: add taxonomy + article calls
- `frontend/src/routes.tsx` — modify: add `/admin/articles`

**Frontend — public slice (Task 5, depends on Task 3):**
- `frontend/src/pages/ArticleList.tsx`, `frontend/src/pages/ArticleView.tsx` — new
- `frontend/src/pages/articleSearch.ts` — new: pure query-string helper, unit-tested
- `frontend/src/pages/articleSearch.test.ts` — new
- `frontend/src/api/articlesApi.ts` — new
- `frontend/src/routes.tsx` — modify: add `/articles` and `/articles/:id`

---

### Task 1: Database schema and shared type contract

**Files:**
- Create: `backend/src/shared/db/schema/taxonomy.ts`
- Create: `backend/src/shared/db/schema/articles.ts`
- Modify: `backend/src/shared/db/schema/enums.ts`
- Modify: `backend/src/shared/db/schema/index.ts`
- Modify: `backend/src/shared/db/sql/001_extensions.sql`
- Create: `packages/types/src/articles.ts`
- Modify: `packages/types/src/index.ts`
- Modify: `backend/tests/schema.test.ts`
- Test: `backend/tests/schema.test.ts` (extended), `backend/tests/rls.test.ts` (existing generic drift-guard, unmodified but must still pass)

**Interfaces:**
- Produces (Drizzle tables, consumed by Tasks 2 & 3): `intent`, `subintent` from `taxonomy.ts`; `article`, `articlePhrasing`, `articleEmbedding`, `articleAttachment` from `articles.ts`. Each exposes Drizzle's inferred row type as `(typeof article).$inferSelect` etc.
- Produces (types/schemas, consumed by Tasks 2, 3, 4, 5 via `@support/types`): `CreateIntentBody`, `CreateSubintentBody`, `CreateArticleBody`, `UpdateArticleBody`, `PublicArticleListQuery` (Zod); `ArticleStateValue`, `IntentSubintentView`, `IntentView`, `IntentsResponse`, `CreateIntentResponse`, `CreateSubintentResponse`, `AgentArticleSummary`, `AgentArticlesResponse`, `AgentArticleDetail`, `PublicArticleSummary`, `PublicArticlesResponse`, `PublicArticleDetail` (plain types).

- [ ] **Step 1: Add the `vector` Postgres extension**

Edit `backend/src/shared/db/sql/001_extensions.sql`:

```sql
-- citext backs agent.email. gen_random_uuid() is built in from Postgres 13, so
-- pgcrypto is not needed. pgvector backs article_embedding.embedding.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
```

- [ ] **Step 2: Add the `article_state` enum**

Edit `backend/src/shared/db/schema/enums.ts`, appending:

```typescript
export const articleState = pgEnum('article_state', ['draft', 'published', 'archived'])
```

- [ ] **Step 3: Write the taxonomy schema**

Create `backend/src/shared/db/schema/taxonomy.ts`:

```typescript
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { conversationPriority } from './enums.ts'
import { workspace } from './identity.ts'

const tz = { withTimezone: true, mode: 'date' } as const

export const intent = pgTable(
  'intent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Guards 'Other' — checked in the archive handler when one ships. Not exposed by this slice's API. */
    isSystem: boolean('is_system').notNull().default(false),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('intent_workspace_name_uk').on(t.workspaceId, t.name)],
)

export const subintent = pgTable(
  'subintent',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** No consumer yet — see the design doc. Column exists so routing work later needs no migration. */
    defaultPriority: conversationPriority('default_priority'),
    /** No form table yet, no FK yet. */
    formId: uuid('form_id'),
    /** No merge flow yet. Self-referential FK needs the AnyPgColumn getter form. */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => subintent.id, { onDelete: 'restrict' }),
    archivedAt: timestamp('archived_at', tz),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('subintent_workspace_intent_name_uk').on(t.workspaceId, t.intentId, t.name)],
)
```

- [ ] **Step 4: Write the articles schema**

Create `backend/src/shared/db/schema/articles.ts`:

```typescript
import { index, pgTable, text, timestamp, uuid, vector } from 'drizzle-orm/pg-core'
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
  summary: text('summary'),
  state: articleState('state').notNull().default('draft'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => agent.id, { onDelete: 'restrict' }),
  publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

export const articlePhrasing = pgTable('article_phrasing', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  phrase: text('phrase').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
})

/** Schema-only in this slice — nothing writes to it until bot retrieval lands. */
export const articleEmbedding = pgTable(
  'article_embedding',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict' }),
    articleId: uuid('article_id')
      .notNull()
      .references(() => article.id, { onDelete: 'restrict' }),
    /** 'summary' | 'phrasing' */
    source: text('source').notNull(),
    phrasingId: uuid('phrasing_id').references(() => articlePhrasing.id, { onDelete: 'restrict' }),
    embedding: vector('embedding', { dimensions: 1536 }),
    model: text('model'),
    syncedAt: timestamp('synced_at', tz),
  },
  (t) => [index('article_embedding_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops'))],
)

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

- [ ] **Step 5: Barrel-export the new schema files**

Edit `backend/src/shared/db/schema/index.ts`:

```typescript
export * from './enums.ts'
export * from './identity.ts'
export * from './players.ts'
export * from './playerState.ts'
export * from './conversations.ts'
export * from './events.ts'
export * from './taxonomy.ts'
export * from './articles.ts'
```

- [ ] **Step 6: Write the shared Zod/type contract**

Create `packages/types/src/articles.ts`:

```typescript
import { z } from 'zod'

/**
 * NOT part of the frozen SDK contract — ships with the server, same as chat.ts
 * and surface.ts. Shared by the agent console, the public surface, and OpenAPI.
 */
export const CreateIntentBody = z.object({ name: z.string().min(1).max(120) })
export const CreateSubintentBody = z.object({ name: z.string().min(1).max(120) })

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

export const PublicArticleListQuery = z.object({
  intentId: z.uuid().optional(),
  q: z.string().min(1).max(200).optional(),
})

export type ArticleStateValue = 'draft' | 'published' | 'archived'

export type IntentSubintentView = { id: string; name: string }
export type IntentView = { id: string; name: string; subintents: IntentSubintentView[] }
export type IntentsResponse = { intents: IntentView[] }
export type CreateIntentResponse = { id: string; name: string }
export type CreateSubintentResponse = { id: string; name: string; intent_id: string }

export type AgentArticleSummary = {
  id: string
  title: string
  state: ArticleStateValue
  intent_id: string | null
  created_at: string
  published_at: string | null
}
export type AgentArticlesResponse = { articles: AgentArticleSummary[] }

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

Edit `packages/types/src/index.ts`:

```typescript
export * from './chat.ts'
export * from './player-state.ts'
export * from './sdk-wire.ts'
export * from './surface.ts'
export * from './articles.ts'
```

- [ ] **Step 7: Update the schema table-count test to fail (red)**

Edit `backend/tests/schema.test.ts`, replacing `EXPECTED_TABLES`:

```typescript
const EXPECTED_TABLES = [
  'agent',
  'article',
  'article_attachment',
  'article_embedding',
  'article_phrasing',
  'conversation',
  'declared_field',
  'event',
  'intent',
  'message',
  'player',
  'player_state_snapshot',
  'session',
  'subintent',
  'workspace',
  'workspace_member',
]
```

Also update the test's own description text, since "ten tables" is now wrong:

```typescript
  it('creates exactly the sixteen tables of the SDK-path + articles-KB subset', async () => {
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `pnpm --filter @support/api test -- schema.test.ts`
Expected: FAIL — the actual table list from `information_schema.tables` is still the old ten; the new six aren't in the database yet.

- [ ] **Step 9: Apply the schema and confirm the test passes**

Run: `pnpm db:setup`
Then run: `pnpm --filter @support/api test -- schema.test.ts`
Expected: PASS. If `db:setup` fails on the `vector` extension not being installed in the local Postgres image, confirm the Docker image is `pgvector/pgvector:pg17` per `CLAUDE.md`'s stack table (`docker-compose.yml`) and re-pull if it was overridden locally.

- [ ] **Step 10: Run the full backend suite to confirm nothing else regressed**

Run: `pnpm --filter @support/api test`
Expected: PASS, including the existing `rls.test.ts` drift-guard tests (`'finds no scoped table missing full RLS treatment'` and the inverse), which pick up the six new tables automatically since they key off "has a `workspace_id` column," not a hardcoded list.

- [ ] **Step 11: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. `packages/types` must build clean before Tasks 2–5 can import from it.

- [ ] **Step 12: Commit**

```bash
git add backend/src/shared/db/schema/taxonomy.ts backend/src/shared/db/schema/articles.ts \
  backend/src/shared/db/schema/enums.ts backend/src/shared/db/schema/index.ts \
  backend/src/shared/db/sql/001_extensions.sql packages/types/src/articles.ts \
  packages/types/src/index.ts backend/tests/schema.test.ts
git commit -m "feat: add taxonomy and articles schema, shared article types"
```

---

### Task 2: Agent console — taxonomy admin endpoints and article CRUD/publish/archive

**Depends on:** Task 1 (schema + `@support/types` articles contract).
**Runs in parallel with:** Task 3 (touches only `backend/src/agent/*` and shares only the additive, non-overlapping-section edit to `backend/src/docs/openapi.ts`).

**Files:**
- Create: `backend/src/shared/middleware/requireAdminRole.ts`
- Create: `backend/src/agent/services/taxonomyService.ts`
- Create: `backend/src/agent/controllers/taxonomyController.ts`
- Create: `backend/src/agent/routers/taxonomyRouter.ts`
- Create: `backend/src/agent/services/articlesService.ts`
- Create: `backend/src/agent/controllers/articlesController.ts`
- Create: `backend/src/agent/routers/articlesRouter.ts`
- Modify: `backend/src/agent/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.taxonomy.test.ts`, `backend/tests/agent.articles.test.ts`

**Interfaces:**
- Consumes: `intent`, `subintent`, `article` (Drizzle tables, Task 1); `withWorkspace(workspaceId, fn)` from `backend/src/shared/db/withWorkspace.ts`; `AgentContext = { agentId: string; workspaceId: string }` from `backend/src/shared/middleware/requireAgentSession.ts`; `sendError(res, status, code, message)` from `backend/src/errors.ts`; `CreateIntentBody`, `CreateSubintentBody`, `CreateArticleBody`, `UpdateArticleBody`, and all `Agent*`/`*Response` types from `@support/types` (Task 1).
- Produces (consumed by Task 4): `GET /agent/intents` → `IntentsResponse`; `POST /agent/intents` → `CreateIntentResponse`; `POST /agent/intents/:id/subintents` → `CreateSubintentResponse`; `GET /agent/articles` → `AgentArticlesResponse`; `GET /agent/articles/:id` → `AgentArticleDetail`; `POST /agent/articles` → `AgentArticleDetail`; `PATCH /agent/articles/:id` → `AgentArticleDetail`; `POST /agent/articles/:id/publish` → `AgentArticleDetail`; `POST /agent/articles/:id/archive` → `AgentArticleDetail`.
- Produces (middleware, consumed by nothing else in this slice but documented for later admin-gated endpoints): `requireAdminRole: RequestHandler`, applied per-route after `requireAgentSession`.

**Why role is looked up per-request, not embedded in the JWT:** the agent session JWT (`AgentSessionClaims`) carries only `agent_id`/`workspace_id`. Embedding `role` would let a demoted admin's existing session keep admin power until it expires, the same staleness bug `PLAYER_TOKEN_TTL_SECONDS` already warns about for player tokens. `requireAdminRole` re-reads `workspace_member.role` from the database on every admin-gated request instead.

- [ ] **Step 1: Write the `requireAdminRole` middleware test (failing)**

Create `backend/tests/agent.taxonomy.test.ts`:

```typescript
import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { taxonomyRouter } from '../src/agent/routers/taxonomyRouter.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

// Standalone app carrying just this router, gated by the real
// requireAgentSession/requireAdminRole middleware — mirrors
// agent.conversations.test.ts's rationale: this keeps the test from racing
// Task 3's edits to backend/src/surface/router.ts, and from needing
// backend/src/agent/router.ts wired before this task's own Step 8 does it.
const app = express()
app.use(express.json())
app.use(requireAgentSession, taxonomyRouter)
app.use(errorMiddleware)

beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function seedAgentWithRole(workspaceId: string, role: 'agent' | 'admin'): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`${role}-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, $3)`, [
    workspaceId,
    agentId,
    role,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('GET /intents', () => {
  it('lists intents with nested subintents for any role', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    )
    await ownerPool.query(`insert into subintent (workspace_id, intent_id, name) values ($1, $2, 'Refunds')`, [
      workspaceId,
      rows[0]!.id,
    ])
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    const res = await request(app).get('/intents').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.intents).toHaveLength(1)
    expect(res.body.intents[0].name).toBe('Billing')
    expect(res.body.intents[0].subintents).toEqual([{ id: expect.any(String), name: 'Refunds' }])
  })
})

describe('POST /intents', () => {
  it('creates an intent for an admin', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .post('/intents')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Billing' })
      .expect(201)

    expect(res.body).toEqual({ id: expect.any(String), name: 'Billing' })
  })

  it('refuses a non-admin agent with 403, not 404', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgentWithRole(workspaceId, 'agent')

    await request(app).post('/intents').set('Authorization', `Bearer ${token}`).send({ name: 'Billing' }).expect(403)
  })
})

describe('POST /intents/:id/subintents', () => {
  it('creates a subintent for an admin', async () => {
    const workspaceId = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceId],
    )
    const { token } = await seedAgentWithRole(workspaceId, 'admin')

    const res = await request(app)
      .post(`/intents/${rows[0]!.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refunds' })
      .expect(201)

    expect(res.body).toEqual({ id: expect.any(String), name: 'Refunds', intent_id: rows[0]!.id })
  })

  it('404s for an intent id from another workspace — invisible under RLS', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    )
    const { token } = await seedAgentWithRole(workspaceA, 'admin')

    await request(app)
      .post(`/intents/${rows[0]!.id}/subintents`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Refunds' })
      .expect(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test -- agent.taxonomy.test.ts`
Expected: FAIL — `../src/agent/routers/taxonomyRouter.ts` does not exist yet.

- [ ] **Step 3: Implement `requireAdminRole`**

Create `backend/src/shared/middleware/requireAdminRole.ts`:

```typescript
import type { RequestHandler } from 'express'
import { and, eq, isNull } from 'drizzle-orm'
import { sendError } from '../../errors.ts'
import { workspaceMember } from '../db/schema/index.ts'
import { withWorkspace } from '../db/withWorkspace.ts'

/**
 * Runs after requireAgentSession. Role is not carried in the session JWT (see
 * Task 2's plan note), so this re-reads workspace_member on every request — a
 * demoted admin loses the ability to hit an admin-gated route on their very
 * next request, not at token expiry.
 */
export const requireAdminRole: RequestHandler = async (req, res, next) => {
  const ctx = req.agent!
  const isAdmin = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({ role: workspaceMember.role })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.agentId, ctx.agentId), isNull(workspaceMember.deactivatedAt)))
      .limit(1)
    return row?.role === 'admin'
  })
  if (!isAdmin) {
    sendError(res, 403, 'forbidden', 'Admin role required.')
    return
  }
  next()
}
```

- [ ] **Step 4: Implement the taxonomy service**

Create `backend/src/agent/services/taxonomyService.ts`:

```typescript
import { asc, eq } from 'drizzle-orm'
import type { CreateIntentResponse, CreateSubintentResponse, IntentsResponse } from '@support/types'
import { intent, subintent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

export async function listIntents(ctx: AgentContext): Promise<IntentsResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const intents = await tx.select({ id: intent.id, name: intent.name }).from(intent).orderBy(asc(intent.name))
    const subintents = await tx
      .select({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
      .from(subintent)
      .orderBy(asc(subintent.name))
    return {
      intents: intents.map((i) => ({
        id: i.id,
        name: i.name,
        subintents: subintents.filter((s) => s.intentId === i.id).map((s) => ({ id: s.id, name: s.name })),
      })),
    }
  })
}

export async function createIntent(ctx: AgentContext, name: string): Promise<CreateIntentResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .insert(intent)
      .values({ workspaceId: ctx.workspaceId, name })
      .returning({ id: intent.id, name: intent.name })
    return row!
  })
}

export type CreateSubintentResult = { ok: true; subintent: CreateSubintentResponse } | { ok: false; reason: 'intent_not_found' }

export async function createSubintent(ctx: AgentContext, intentId: string, name: string): Promise<CreateSubintentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [parent] = await tx.select({ id: intent.id }).from(intent).where(eq(intent.id, intentId)).limit(1)
    if (!parent) return { ok: false, reason: 'intent_not_found' }
    const [row] = await tx
      .insert(subintent)
      .values({ workspaceId: ctx.workspaceId, intentId, name })
      .returning({ id: subintent.id, name: subintent.name, intentId: subintent.intentId })
    return { ok: true, subintent: { id: row!.id, name: row!.name, intent_id: row!.intentId } }
  })
}
```

- [ ] **Step 5: Implement the taxonomy controller and router**

Create `backend/src/agent/controllers/taxonomyController.ts`:

```typescript
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { CreateIntentBody, CreateSubintentBody } from '@support/types'
import { sendError } from '../../errors.ts'
import { createIntent, createSubintent, listIntents } from '../services/taxonomyService.ts'

const IntentIdParams = z.object({ id: z.uuid() })

export const listIntentsHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listIntents(req.agent!))
}

export const createIntentHandler: RequestHandler = async (req, res) => {
  const body = CreateIntentBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'name is required.')
    return
  }
  res.status(201).json(await createIntent(req.agent!, body.data.name))
}

export const createSubintentHandler: RequestHandler = async (req, res) => {
  const params = IntentIdParams.safeParse(req.params)
  const body = CreateSubintentBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'A valid intent id and name are required.')
    return
  }
  const result = await createSubintent(req.agent!, params.data.id, body.data.name)
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Intent not found.')
    return
  }
  res.status(201).json(result.subintent)
}
```

Create `backend/src/agent/routers/taxonomyRouter.ts`:

```typescript
import { Router } from 'express'
import { requireAdminRole } from '../../shared/middleware/requireAdminRole.ts'
import { createIntentHandler, createSubintentHandler, listIntentsHandler } from '../controllers/taxonomyController.ts'

export const taxonomyRouter = Router()
taxonomyRouter.get('/intents', listIntentsHandler)
taxonomyRouter.post('/intents', requireAdminRole, createIntentHandler)
taxonomyRouter.post('/intents/:id/subintents', requireAdminRole, createSubintentHandler)
```

- [ ] **Step 6: Run the taxonomy test to verify it passes**

Run: `pnpm --filter @support/api test -- agent.taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the article CRUD/publish/archive test (failing)**

Create `backend/tests/agent.articles.test.ts`:

```typescript
import { createServer } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts'
import { signAgentSession } from '../src/shared/auth/agentSession.ts'
import { closeSocketServer, createSocketServer } from '../src/shared/realtime/socketServer.ts'
import { articlesRouter } from '../src/agent/routers/articlesRouter.ts'
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts'

const app = express()
app.use(express.json())
app.use(requireAgentSession, articlesRouter)
app.use(errorMiddleware)

beforeAll(() => {
  createSocketServer(createServer())
})

afterAll(async () => {
  await closeSocketServer()
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function seedAgent(workspaceId: string): Promise<{ agentId: string; token: string }> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  await ownerPool.query(`insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`, [
    workspaceId,
    agentId,
  ])
  const token = await signAgentSession({ agent_id: agentId, workspace_id: workspaceId })
  return { agentId, token }
}

describe('POST /articles', () => {
  it('creates a draft', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const res = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'How to reset your password', body: 'Go to settings...' })
      .expect(201)

    expect(res.body).toMatchObject({ title: 'How to reset your password', state: 'draft', intent_id: null })
  })

  it('404s when intent_id belongs to another workspace', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into intent (workspace_id, name) values ($1, 'Billing') returning id`,
      [workspaceB],
    )
    const { token } = await seedAgent(workspaceA)

    await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y', intent_id: rows[0]!.id })
      .expect(404)
  })
})

describe('draft -> publish -> archive', () => {
  it('walks the full state machine', async () => {
    const workspaceId = await seedWorkspace()
    const { token } = await seedAgent(workspaceId)

    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', body: 'Y' })
      .expect(201)
    const id = created.body.id as string

    const patched = await request(app)
      .patch(`/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated title' })
      .expect(200)
    expect(patched.body.title).toBe('Updated title')

    const published = await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(published.body.state).toBe('published')
    expect(published.body.published_by).toBeTruthy()
    expect(published.body.published_at).toBeTruthy()

    await request(app)
      .patch(`/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Should fail' })
      .expect(409)

    await request(app).post(`/articles/${id}/publish`).set('Authorization', `Bearer ${token}`).expect(409)

    const archived = await request(app).post(`/articles/${id}/archive`).set('Authorization', `Bearer ${token}`).expect(200)
    expect(archived.body.state).toBe('archived')
  })

  it('refuses to publish empty title or body with 409', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId } = await seedAgent(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, ' ', ' ', $2) returning id`,
      [workspaceId, agentId],
    )
    const { token } = await seedAgent(workspaceId)

    await request(app).post(`/articles/${rows[0]!.id}/publish`).set('Authorization', `Bearer ${token}`).expect(409)
  })

  it('archive succeeds from any state, unlike patch and publish', async () => {
    const workspaceId = await seedWorkspace()
    const { agentId } = await seedAgent(workspaceId)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, state, created_by, published_at)
       values ($1, 'X', 'Y', 'published', $2, now()) returning id`,
      [workspaceId, agentId],
    )
    const { token } = await seedAgent(workspaceId)

    await request(app).post(`/articles/${rows[0]!.id}/archive`).set('Authorization', `Bearer ${token}`).expect(200)
  })
})

describe('workspace isolation', () => {
  it('GET /articles/:id 404s for another workspace article', async () => {
    const workspaceA = await seedWorkspace()
    const workspaceB = await seedWorkspace()
    const { agentId } = await seedAgent(workspaceB)
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, 'X', 'Y', $2) returning id`,
      [workspaceB, agentId],
    )
    const { token } = await seedAgent(workspaceA)

    await request(app).get(`/articles/${rows[0]!.id}`).set('Authorization', `Bearer ${token}`).expect(404)
  })
})
```

- [ ] **Step 8: Run the test to verify it fails**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts`
Expected: FAIL — `../src/agent/routers/articlesRouter.ts` does not exist yet.

- [ ] **Step 9: Implement the article service**

Create `backend/src/agent/services/articlesService.ts`:

```typescript
import { desc, eq } from 'drizzle-orm'
import type { AgentArticleDetail, AgentArticlesResponse } from '@support/types'
import { article, intent } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts'

function toDetail(row: typeof article.$inferSelect): AgentArticleDetail {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    summary: row.summary,
    state: row.state,
    intent_id: row.intentId,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  }
}

export async function listArticles(ctx: AgentContext): Promise<AgentArticlesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx.select().from(article).orderBy(desc(article.createdAt))
    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        state: r.state,
        intent_id: r.intentId,
        created_at: r.createdAt.toISOString(),
        published_at: r.publishedAt ? r.publishedAt.toISOString() : null,
      })),
    }
  })
}

export async function getArticle(ctx: AgentContext, id: string): Promise<AgentArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.select().from(article).where(eq(article.id, id)).limit(1)
    return row ? toDetail(row) : null
  })
}

export type CreateArticleInput = { title: string; body: string; summary?: string; intentId?: string }
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
        summary: input.summary ?? null,
        createdBy: ctx.agentId,
      })
      .returning()
    return { ok: true, article: toDetail(row!) }
  })
}

export type UpdateArticleInput = { title?: string; body?: string; summary?: string | null; intentId?: string | null }
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
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.intentId !== undefined ? { intentId: patch.intentId } : {}),
      })
      .where(eq(article.id, id))
      .returning()
    return { ok: true, article: toDetail(row!) }
  })
}

export type PublishArticleResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'empty_fields' }

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
    return { ok: true, article: toDetail(row!) }
  })
}

export type ArchiveArticleResult = { ok: true; article: AgentArticleDetail } | { ok: false; reason: 'not_found' }

export async function archiveArticle(ctx: AgentContext, id: string): Promise<ArchiveArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.update(article).set({ state: 'archived' }).where(eq(article.id, id)).returning()
    if (!row) return { ok: false, reason: 'not_found' }
    return { ok: true, article: toDetail(row) }
  })
}
```

- [ ] **Step 10: Implement the article controller and router**

Create `backend/src/agent/controllers/articlesController.ts`:

```typescript
import type { RequestHandler } from 'express'
import { z } from 'zod'
import { CreateArticleBody, UpdateArticleBody } from '@support/types'
import { sendError } from '../../errors.ts'
import {
  archiveArticle,
  createArticle,
  getArticle,
  listArticles,
  publishArticle,
  updateArticle,
} from '../services/articlesService.ts'

const ArticleIdParams = z.object({ id: z.uuid() })

export const listArticlesHandler: RequestHandler = async (req, res) => {
  res.status(200).json(await listArticles(req.agent!))
}

export const getArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const found = await getArticle(req.agent!, params.data.id)
  if (!found) {
    sendError(res, 404, 'not_found', 'Article not found.')
    return
  }
  res.status(200).json(found)
}

export const createArticleHandler: RequestHandler = async (req, res) => {
  const body = CreateArticleBody.safeParse(req.body)
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'title and body are required.')
    return
  }
  const result = await createArticle(req.agent!, {
    title: body.data.title,
    body: body.data.body,
    summary: body.data.summary,
    intentId: body.data.intent_id,
  })
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Intent not found.')
    return
  }
  res.status(201).json(result.article)
}

export const updateArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  const body = UpdateArticleBody.safeParse(req.body)
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid article update payload.')
    return
  }
  const result = await updateArticle(req.agent!, params.data.id, {
    title: body.data.title,
    body: body.data.body,
    summary: body.data.summary,
    intentId: body.data.intent_id,
  })
  if (!result.ok) {
    if (result.reason === 'not_found' || result.reason === 'intent_not_found') {
      sendError(res, 404, 'not_found', 'Article or intent not found.')
      return
    }
    sendError(res, 409, 'invalid_request', 'Article is not a draft.')
    return
  }
  res.status(200).json(result.article)
}

export const publishArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await publishArticle(req.agent!, params.data.id)
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.')
      return
    }
    const message = result.reason === 'empty_fields' ? 'Title and body must be non-empty to publish.' : 'Article is not a draft.'
    sendError(res, 409, 'invalid_request', message)
    return
  }
  res.status(200).json(result.article)
}

export const archiveArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const result = await archiveArticle(req.agent!, params.data.id)
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article not found.')
    return
  }
  res.status(200).json(result.article)
}
```

Create `backend/src/agent/routers/articlesRouter.ts`:

```typescript
import { Router } from 'express'
import {
  archiveArticleHandler,
  createArticleHandler,
  getArticleHandler,
  listArticlesHandler,
  publishArticleHandler,
  updateArticleHandler,
} from '../controllers/articlesController.ts'

export const articlesRouter = Router()
articlesRouter.get('/articles', listArticlesHandler)
articlesRouter.get('/articles/:id', getArticleHandler)
articlesRouter.post('/articles', createArticleHandler)
articlesRouter.patch('/articles/:id', updateArticleHandler)
articlesRouter.post('/articles/:id/publish', publishArticleHandler)
articlesRouter.post('/articles/:id/archive', archiveArticleHandler)
```

- [ ] **Step 11: Run the article test to verify it passes**

Run: `pnpm --filter @support/api test -- agent.articles.test.ts`
Expected: PASS.

- [ ] **Step 12: Wire both routers into the agent app**

Edit `backend/src/agent/router.ts`:

```typescript
import { Router } from 'express'
import { requireAgentSession } from '../shared/middleware/requireAgentSession.ts'
import { authRouter } from './routers/authRouter.ts'
import { conversationsRouter } from './routers/conversationsRouter.ts'
import { messagesRouter } from './routers/messagesRouter.ts'
import { taxonomyRouter } from './routers/taxonomyRouter.ts'
import { articlesRouter } from './routers/articlesRouter.ts'

export const agentRouter = Router()

// Public: this IS the login flow, so it cannot require the session it mints.
agentRouter.use(authRouter)

agentRouter.use(requireAgentSession)
agentRouter.use(taxonomyRouter)
agentRouter.use(articlesRouter)
agentRouter.use(conversationsRouter)
agentRouter.use(messagesRouter)
```

- [ ] **Step 13: Register OpenAPI paths**

Edit `backend/src/docs/openapi.ts`, inserting a new section after `// --- 4. AGENT ENDPOINTS ---`'s existing entries (before `// Build Document`):

```typescript
// --- 5. AGENT TAXONOMY & ARTICLE ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/agent/intents',
  summary: 'Agent List Intents',
  description: 'Lists intents with nested subintents, for the category picker.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Intents list' } },
})

registry.registerPath({
  method: 'post',
  path: '/agent/intents',
  summary: 'Agent Create Intent',
  description: 'Creates an intent inline. Admin-only, enforced server-side.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } } } },
  responses: {
    201: { description: 'Intent created' },
    403: { description: 'Forbidden — admin role required' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/intents/{id}/subintents',
  summary: 'Agent Create Subintent',
  description: 'Creates a subintent under an intent. Admin-only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: { content: { 'application/json': { schema: z.object({ name: z.string().min(1).max(120) }) } } },
  },
  responses: {
    201: { description: 'Subintent created' },
    403: { description: 'Forbidden — admin role required' },
    404: { description: 'Intent not found' },
  },
})

registry.registerPath({
  method: 'get',
  path: '/agent/articles',
  summary: 'Agent List Articles',
  description: 'Lists articles in all states for this workspace.',
  security: [{ [bearerAgentJwt.name]: [] }],
  responses: { 200: { description: 'Articles list' } },
})

registry.registerPath({
  method: 'get',
  path: '/agent/articles/{id}',
  summary: 'Agent Get Article',
  description: 'Fetches one article for editing.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article detail' }, 404: { description: 'Not found' } },
})

registry.registerPath({
  method: 'post',
  path: '/agent/articles',
  summary: 'Agent Create Article',
  description: 'Creates a draft article.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(200),
            body: z.string().min(1),
            summary: z.string().max(500).optional(),
            intent_id: z.uuid().optional(),
          }),
        },
      },
    },
  },
  responses: { 201: { description: 'Draft created' }, 404: { description: 'Intent not found' } },
})

registry.registerPath({
  method: 'patch',
  path: '/agent/articles/{id}',
  summary: 'Agent Update Article',
  description: 'Edits title/body/summary/intent while in draft.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().min(1).max(200).optional(),
            body: z.string().min(1).optional(),
            summary: z.string().max(500).nullable().optional(),
            intent_id: z.uuid().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Article updated' },
    404: { description: 'Not found' },
    409: { description: 'Article is not a draft' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/publish',
  summary: 'Agent Publish Article',
  description: "draft -> published, stamps published_by/published_at.",
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Article published' },
    404: { description: 'Not found' },
    409: { description: 'Not a draft, or title/body empty' },
  },
})

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/archive',
  summary: 'Agent Archive Article',
  description: 'Any state -> archived. No delete route exists.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article archived' }, 404: { description: 'Not found' } },
})
```

- [ ] **Step 14: Run the full backend suite**

Run: `pnpm --filter @support/api test`
Expected: PASS.

- [ ] **Step 15: Typecheck and confirm `/docs/json` includes the new paths**

Run: `pnpm typecheck`
Run: `pnpm dev` (in one terminal), then `curl -s http://localhost:4000/docs/json | grep -o '"/agent/[^"]*"' | sort -u`
Expected: the nine agent paths from `/agent/intents` through `/agent/articles/{id}/archive` are present.

- [ ] **Step 16: Commit**

```bash
git add backend/src/shared/middleware/requireAdminRole.ts \
  backend/src/agent/services/taxonomyService.ts backend/src/agent/controllers/taxonomyController.ts backend/src/agent/routers/taxonomyRouter.ts \
  backend/src/agent/services/articlesService.ts backend/src/agent/controllers/articlesController.ts backend/src/agent/routers/articlesRouter.ts \
  backend/src/agent/router.ts backend/src/docs/openapi.ts \
  backend/tests/agent.taxonomy.test.ts backend/tests/agent.articles.test.ts
git commit -m "feat: agent-console taxonomy admin endpoints and article CRUD/publish/archive"
```

---

### Task 3: Public surface — article search and read

**Depends on:** Task 1 only.
**Runs in parallel with:** Task 2 (touches only `backend/src/surface/*` and the same additive `openapi.ts`).

**Files:**
- Create: `backend/src/surface/services/articlesService.ts`
- Create: `backend/src/surface/controllers/articlesController.ts`
- Create: `backend/src/surface/routers/articlesRouter.ts`
- Modify: `backend/src/surface/router.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/surface.articles.test.ts`

**Interfaces:**
- Consumes: `article` (Drizzle table, Task 1); `withWorkspace`; `PlayerContext = { workspaceId: string; playerId: string; ... }` from `backend/src/shared/middleware/requirePlayerToken.ts`; `PublicArticlesResponse`, `PublicArticleDetail` from `@support/types` (Task 1).
- Produces (consumed by Task 5): `GET /surface/articles?intentId=&q=` → `PublicArticlesResponse`; `GET /surface/articles/:id` → `PublicArticleDetail`.

See the "Architectural note on public-route auth" section above the task list for why this mounts under `surfaceRouter` (inheriting `requirePlayerToken`) rather than building a new tokenless path.

- [ ] **Step 1: Write the failing test**

Create `backend/tests/surface.articles.test.ts`:

```typescript
import express from 'express'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { closeDb } from '../src/shared/db/client.ts'
import { errorMiddleware } from '../src/errors.ts'
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts'
import { articlesRouter } from '../src/surface/routers/articlesRouter.ts'
import { closeOwnerPool, ownerPool, seedPlayer, seedWorkspace, truncateAll } from './helpers/db.ts'
import { mintToken } from './helpers/app.ts'

const app = express()
app.use(express.json())
app.use(requirePlayerToken, articlesRouter)
app.use(errorMiddleware)

afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

beforeEach(truncateAll)

async function fixture() {
  const workspaceId = await seedWorkspace()
  const playerId = await seedPlayer(workspaceId)
  const token = await mintToken({ workspace_id: workspaceId, player_id: playerId, external_player_id: 'p-1' })
  return { workspaceId, playerId, token }
}

async function seedArticle(workspaceId: string, overrides: Partial<{ title: string; body: string; state: string; intentId: string | null }> = {}) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'A') returning id`,
    [`a-${Math.random().toString(36).slice(2)}@example.test`],
  )
  const agentId = rows[0]!.id
  const { rows: articleRows } = await ownerPool.query<{ id: string }>(
    `insert into article (workspace_id, intent_id, title, body, state, created_by, published_at)
     values ($1, $2, $3, $4, $5, $6, case when $5 = 'published' then now() else null end) returning id`,
    [
      workspaceId,
      overrides.intentId ?? null,
      overrides.title ?? 'How to reset your password',
      overrides.body ?? 'Go to settings and tap reset.',
      overrides.state ?? 'published',
      agentId,
    ],
  )
  return articleRows[0]!.id
}

describe('GET /articles', () => {
  it('returns only published articles', async () => {
    const { workspaceId, token } = await fixture()
    await seedArticle(workspaceId, { state: 'published', title: 'Published one' })
    await seedArticle(workspaceId, { state: 'draft', title: 'Draft one' })

    const res = await request(app).get('/articles').set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toHaveLength(1)
    expect(res.body.articles[0].title).toBe('Published one')
  })

  it('filters by keyword across title and body', async () => {
    const { workspaceId, token } = await fixture()
    await seedArticle(workspaceId, { title: 'Refund policy', body: 'We refund within 30 days.' })
    await seedArticle(workspaceId, { title: 'Password reset', body: 'Tap reset.' })

    const res = await request(app).get('/articles').query({ q: 'refund' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toHaveLength(1)
    expect(res.body.articles[0].title).toBe('Refund policy')
  })

  it('returns an empty list, never an error, when nothing matches', async () => {
    const { token } = await fixture()

    const res = await request(app).get('/articles').query({ q: 'nonexistent' }).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.articles).toEqual([])
  })
})

describe('GET /articles/:id', () => {
  it('returns a published article', async () => {
    const { workspaceId, token } = await fixture()
    const id = await seedArticle(workspaceId, { state: 'published' })

    const res = await request(app).get(`/articles/${id}`).set('Authorization', `Bearer ${token}`).expect(200)

    expect(res.body.id).toBe(id)
  })

  it('404s for a draft article', async () => {
    const { workspaceId, token } = await fixture()
    const id = await seedArticle(workspaceId, { state: 'draft' })

    await request(app).get(`/articles/${id}`).set('Authorization', `Bearer ${token}`).expect(404)
  })

  it('404s for another workspace article — invisible under RLS', async () => {
    const other = await seedWorkspace()
    const id = await seedArticle(other, { state: 'published' })
    const { token } = await fixture()

    await request(app).get(`/articles/${id}`).set('Authorization', `Bearer ${token}`).expect(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/api test -- surface.articles.test.ts`
Expected: FAIL — `../src/surface/routers/articlesRouter.ts` does not exist yet.

- [ ] **Step 3: Implement the public article service**

Create `backend/src/surface/services/articlesService.ts`:

```typescript
import { and, desc, eq, ilike, or } from 'drizzle-orm'
import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types'
import { article } from '../../shared/db/schema/index.ts'
import { withWorkspace } from '../../shared/db/withWorkspace.ts'
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts'

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

export async function listPublicArticles(
  ctx: PlayerContext,
  filter: { intentId?: string; q?: string },
): Promise<PublicArticlesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const conditions = [eq(article.state, 'published')]
    if (filter.intentId) conditions.push(eq(article.intentId, filter.intentId))
    if (filter.q) {
      const keyword = or(ilike(article.title, `%${filter.q}%`), ilike(article.body, `%${filter.q}%`))
      if (keyword) conditions.push(keyword)
    }
    const rows = await tx
      .select()
      .from(article)
      .where(and(...conditions))
      .orderBy(desc(article.publishedAt))
    return { articles: rows.map(toSummary) }
  })
}

export async function getPublicArticle(ctx: PlayerContext, id: string): Promise<PublicArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select()
      .from(article)
      .where(and(eq(article.id, id), eq(article.state, 'published')))
      .limit(1)
    return row ? toDetail(row) : null
  })
}
```

- [ ] **Step 4: Implement the public controller and router**

Create `backend/src/surface/controllers/articlesController.ts`:

```typescript
import type { RequestHandler } from 'express'
import { PublicArticleListQuery } from '@support/types'
import { z } from 'zod'
import { sendError } from '../../errors.ts'
import { getPublicArticle, listPublicArticles } from '../services/articlesService.ts'

const ArticleIdParams = z.object({ id: z.uuid() })

export const listPublicArticlesHandler: RequestHandler = async (req, res) => {
  const query = PublicArticleListQuery.safeParse(req.query)
  if (!query.success) {
    sendError(res, 422, 'invalid_request', 'Invalid query parameters.')
    return
  }
  res.status(200).json(await listPublicArticles(req.player!, query.data))
}

export const getPublicArticleHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params)
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.')
    return
  }
  const found = await getPublicArticle(req.player!, params.data.id)
  if (!found) {
    sendError(res, 404, 'not_found', 'Article not found.')
    return
  }
  res.status(200).json(found)
}
```

Create `backend/src/surface/routers/articlesRouter.ts`:

```typescript
import { Router } from 'express'
import { getPublicArticleHandler, listPublicArticlesHandler } from '../controllers/articlesController.ts'

export const articlesRouter = Router()
articlesRouter.get('/articles', listPublicArticlesHandler)
articlesRouter.get('/articles/:id', getPublicArticleHandler)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @support/api test -- surface.articles.test.ts`
Expected: PASS.

- [ ] **Step 6: Wire the router into the surface app**

Edit `backend/src/surface/router.ts`:

```typescript
import { Router } from 'express'
import { requirePlayerToken } from '../shared/middleware/requirePlayerToken.ts'
import { articleReadRouter } from './routers/articleReadRouter.ts'
import { articlesRouter } from './routers/articlesRouter.ts'
import { bootstrapRouter } from './routers/bootstrapRouter.ts'
import { messagesRouter } from './routers/messagesRouter.ts'

export const surfaceRouter = Router()

// requirePlayerToken only. A browser page has no reason to know the workspace slug,
// so requireSdkHeaders is deliberately absent here.
surfaceRouter.use(requirePlayerToken)

surfaceRouter.use(bootstrapRouter)
surfaceRouter.use(articleReadRouter)
surfaceRouter.use(articlesRouter)
surfaceRouter.use(messagesRouter)
```

- [ ] **Step 7: Register OpenAPI paths**

Edit `backend/src/docs/openapi.ts`, adding a new section (placement relative to Task 2's insert does not matter — both are additive and order-independent within the file):

```typescript
// --- 6. SURFACE ARTICLE ENDPOINTS ---
registry.registerPath({
  method: 'get',
  path: '/surface/articles',
  summary: 'Public List Articles',
  description: 'Lists published articles, optionally filtered by intent or keyword.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { query: z.object({ intentId: z.uuid().optional(), q: z.string().min(1).max(200).optional() }) },
  responses: { 200: { description: 'Articles list' } },
})

registry.registerPath({
  method: 'get',
  path: '/surface/articles/{id}',
  summary: 'Public Get Article',
  description: 'Returns a single published article. 404 if draft/archived or wrong workspace.',
  security: [{ [bearerPlayerJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 200: { description: 'Article detail' }, 404: { description: 'Not found' } },
})
```

- [ ] **Step 8: Run the full backend suite**

Run: `pnpm --filter @support/api test`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add backend/src/surface/services/articlesService.ts backend/src/surface/controllers/articlesController.ts \
  backend/src/surface/routers/articlesRouter.ts backend/src/surface/router.ts backend/src/docs/openapi.ts \
  backend/tests/surface.articles.test.ts
git commit -m "feat: public surface article search and read endpoints"
```

*(If Task 2 committed its own `openapi.ts` edit first, `git add`/`commit` here after resolving the trivial two-hunk merge — both edits append non-overlapping `registerPath` blocks.)*

---

### Task 4: Agent console frontend — article editor

**Depends on:** Task 2 (needs `/agent/intents` and `/agent/articles/*` live).
**Runs in parallel with:** Task 5.

**Files:**
- Create: `frontend/src/pages/articleForm.ts`
- Create: `frontend/src/pages/articleForm.test.ts`
- Create: `frontend/src/pages/AdminArticles.tsx`
- Modify: `frontend/src/api/agentApi.ts`
- Modify: `frontend/src/routes.tsx`

**Interfaces:**
- Consumes: `IntentsResponse`, `AgentArticlesResponse`, `AgentArticleDetail`, `CreateIntentResponse`, `CreateSubintentResponse` from `@support/types`; `apiCall` from `frontend/src/api/httpClient.ts`; `loadAgentSession` from `frontend/src/lib/agentSession.ts`.
- Produces: `canEditFields(state: ArticleStateValue): boolean`, `canPublish(state, title, body): boolean` (pure helpers, tested directly, then used by `AdminArticles.tsx` to gate its inputs and buttons).

- [ ] **Step 1: Write the failing test for the pure form-state helpers**

Create `frontend/src/pages/articleForm.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { canEditFields, canPublish } from './articleForm.ts'

describe('canEditFields', () => {
  it('allows edits only while draft', () => {
    expect(canEditFields('draft')).toBe(true)
    expect(canEditFields('published')).toBe(false)
    expect(canEditFields('archived')).toBe(false)
  })
})

describe('canPublish', () => {
  it('requires draft state and non-blank title and body', () => {
    expect(canPublish('draft', 'Title', 'Body')).toBe(true)
    expect(canPublish('draft', '  ', 'Body')).toBe(false)
    expect(canPublish('draft', 'Title', '  ')).toBe(false)
    expect(canPublish('published', 'Title', 'Body')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/web test -- articleForm.test.ts`
Expected: FAIL — `./articleForm.ts` does not exist yet.

- [ ] **Step 3: Implement the pure helpers**

Create `frontend/src/pages/articleForm.ts`:

```typescript
import type { ArticleStateValue } from '@support/types'

export function canEditFields(state: ArticleStateValue): boolean {
  return state === 'draft'
}

export function canPublish(state: ArticleStateValue, title: string, body: string): boolean {
  return state === 'draft' && title.trim() !== '' && body.trim() !== ''
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/web test -- articleForm.test.ts`
Expected: PASS.

- [ ] **Step 5: Add API calls**

Edit `frontend/src/api/agentApi.ts`, appending:

```typescript
import type {
  AgentArticleDetail,
  AgentArticlesResponse,
  CreateIntentResponse,
  CreateSubintentResponse,
  IntentsResponse,
} from '@support/types'

export function fetchIntents(token: string): Promise<IntentsResponse> {
  return apiCall('/agent/intents', token)
}

export function createIntent(token: string, name: string): Promise<CreateIntentResponse> {
  return apiCall('/agent/intents', token, { method: 'POST', body: JSON.stringify({ name }) })
}

export function createSubintent(token: string, intentId: string, name: string): Promise<CreateSubintentResponse> {
  return apiCall(`/agent/intents/${intentId}/subintents`, token, { method: 'POST', body: JSON.stringify({ name }) })
}

export function fetchArticles(token: string): Promise<AgentArticlesResponse> {
  return apiCall('/agent/articles', token)
}

export function fetchArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}`, token)
}

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

export function publishArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}/publish`, token, { method: 'POST' })
}

export function archiveArticle(token: string, id: string): Promise<AgentArticleDetail> {
  return apiCall(`/agent/articles/${id}/archive`, token, { method: 'POST' })
}
```

- [ ] **Step 6: Build the AdminArticles page**

Create `frontend/src/pages/AdminArticles.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import type { AgentArticleDetail } from '@support/types'
import {
  archiveArticle,
  createArticle,
  createIntent,
  createSubintent,
  fetchArticle,
  fetchArticles,
  fetchIntents,
  publishArticle,
  updateArticle,
} from '../api/agentApi.ts'
import { loadAgentSession } from '../lib/agentSession.ts'
import { canEditFields, canPublish } from './articleForm.ts'

export function AdminArticles() {
  const navigate = useNavigate()
  const session = loadAgentSession()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<{ title: string; body: string; summary: string; intentId: string }>({
    title: '',
    body: '',
    summary: '',
    intentId: '',
  })
  const [newIntentName, setNewIntentName] = useState('')
  const [newSubintentName, setNewSubintentName] = useState('')

  useEffect(() => {
    if (!session) navigate('/login')
  }, [session, navigate])

  const intents = useQuery({
    queryKey: ['admin-intents'],
    queryFn: () => fetchIntents(session!.token),
    enabled: session !== null,
  })
  const articles = useQuery({
    queryKey: ['admin-articles'],
    queryFn: () => fetchArticles(session!.token),
    enabled: session !== null,
  })
  const selected = useQuery({
    queryKey: ['admin-article', selectedId],
    queryFn: () => fetchArticle(session!.token, selectedId!),
    enabled: session !== null && selectedId !== null,
  })

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

  const invalidateArticles = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-articles'] })
    void queryClient.invalidateQueries({ queryKey: ['admin-article', selectedId] })
  }

  const createDraft = useMutation({
    mutationFn: () =>
      createArticle(session!.token, {
        title: draft.title,
        body: draft.body,
        summary: draft.summary || undefined,
        intent_id: draft.intentId || undefined,
      }),
    onSuccess: (created: AgentArticleDetail) => {
      setSelectedId(created.id)
      invalidateArticles()
    },
  })

  const saveDraft = useMutation({
    mutationFn: () =>
      updateArticle(session!.token, selectedId!, {
        title: draft.title,
        body: draft.body,
        summary: draft.summary || null,
        intent_id: draft.intentId || null,
      }),
    onSuccess: invalidateArticles,
  })

  const publish = useMutation({
    mutationFn: () => publishArticle(session!.token, selectedId!),
    onSuccess: invalidateArticles,
  })

  const archive = useMutation({
    mutationFn: () => archiveArticle(session!.token, selectedId!),
    onSuccess: invalidateArticles,
  })

  const addIntent = useMutation({
    mutationFn: () => createIntent(session!.token, newIntentName),
    onSuccess: () => {
      setNewIntentName('')
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] })
    },
  })

  const addSubintent = useMutation({
    mutationFn: (intentId: string) => createSubintent(session!.token, intentId, newSubintentName),
    onSuccess: () => {
      setNewSubintentName('')
      void queryClient.invalidateQueries({ queryKey: ['admin-intents'] })
    },
  })

  if (!session) return null

  const state = selected.data?.state ?? 'draft'
  const editable = selectedId === null || canEditFields(state)

  return (
    <main className="admin-articles">
      <h1>Knowledge base</h1>

      <section>
        <h2>Categories</h2>
        <ul>
          {intents.data?.intents.map((intent) => (
            <li key={intent.id}>
              {intent.name}
              <ul>
                {intent.subintents.map((s) => (
                  <li key={s.id}>{s.name}</li>
                ))}
              </ul>
              <input
                placeholder="New subintent"
                value={newSubintentName}
                onChange={(e) => setNewSubintentName(e.target.value)}
              />
              <button type="button" onClick={() => addSubintent.mutate(intent.id)} disabled={addSubintent.isPending}>
                Add subintent
              </button>
            </li>
          ))}
        </ul>
        <input placeholder="New intent" value={newIntentName} onChange={(e) => setNewIntentName(e.target.value)} />
        <button type="button" onClick={() => addIntent.mutate()} disabled={addIntent.isPending}>
          Add intent
        </button>
      </section>

      <section className="admin-articles__layout">
        <div>
          <h2>Articles</h2>
          <button
            type="button"
            onClick={() => {
              setSelectedId(null)
              setDraft({ title: '', body: '', summary: '', intentId: '' })
            }}
          >
            New article
          </button>
          <ul>
            {articles.data?.articles.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => setSelectedId(a.id)}>
                  {a.title} ({a.state})
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2>{selectedId ? 'Edit article' : 'New article'}</h2>
          <input
            placeholder="Title"
            value={draft.title}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          <textarea
            placeholder="Body"
            value={draft.body}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <textarea
            placeholder="Summary"
            value={draft.summary}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          />
          <select
            value={draft.intentId}
            disabled={!editable}
            onChange={(e) => setDraft({ ...draft, intentId: e.target.value })}
          >
            <option value="">Uncategorized</option>
            {intents.data?.intents.map((intent) => (
              <option key={intent.id} value={intent.id}>
                {intent.name}
              </option>
            ))}
          </select>

          <fieldset disabled>
            <legend>Attachments — coming soon</legend>
          </fieldset>

          {selectedId === null ? (
            <button type="button" onClick={() => createDraft.mutate()} disabled={createDraft.isPending || !draft.title || !draft.body}>
              Create draft
            </button>
          ) : (
            <>
              <button type="button" onClick={() => saveDraft.mutate()} disabled={!editable || saveDraft.isPending}>
                Save
              </button>
              <button type="button" onClick={() => publish.mutate()} disabled={!canPublish(state, draft.title, draft.body) || publish.isPending}>
                Publish
              </button>
              <button type="button" onClick={() => archive.mutate()} disabled={archive.isPending}>
                Archive
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  )
}
```

- [ ] **Step 7: Wire the route**

Edit `frontend/src/routes.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom'
import { SupportSurface } from './pages/SupportSurface.tsx'
import { AgentLogin } from './pages/AgentLogin.tsx'
import { AgentInbox } from './pages/AgentInbox.tsx'
import { AgentConversation } from './pages/AgentConversation.tsx'
import { AdminArticles } from './pages/AdminArticles.tsx'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<SupportSurface />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route path="/inbox" element={<AgentInbox />} />
      <Route path="/conversations/:id" element={<AgentConversation />} />
      <Route path="/admin/articles" element={<AdminArticles />} />
    </Routes>
  )
}
```

- [ ] **Step 8: Typecheck and run the frontend suite**

Run: `pnpm --filter @support/web typecheck`
Run: `pnpm --filter @support/web test`
Expected: both PASS.

- [ ] **Step 9: Manual check in the browser**

Run: `pnpm dev`, log in as a dev agent at `/login`, navigate to `/admin/articles`. Create an intent (only visible/effective if the dev agent's `workspace_member.role` is `admin` — check via `pnpm db:studio` and update the seeded row if needed), create a subintent under it, create a draft article, save an edit, publish it, confirm the fields lock and the Save/Publish buttons disable, then archive it.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/pages/articleForm.ts frontend/src/pages/articleForm.test.ts \
  frontend/src/pages/AdminArticles.tsx frontend/src/api/agentApi.ts frontend/src/routes.tsx
git commit -m "feat: agent console article editor with intent/subintent picker"
```

---

### Task 5: Public frontend — article list and view

**Depends on:** Task 3 (needs `/surface/articles*` live).
**Runs in parallel with:** Task 4.

**Files:**
- Create: `frontend/src/pages/articleSearch.ts`
- Create: `frontend/src/pages/articleSearch.test.ts`
- Create: `frontend/src/api/articlesApi.ts`
- Create: `frontend/src/pages/ArticleList.tsx`
- Create: `frontend/src/pages/ArticleView.tsx`
- Modify: `frontend/src/routes.tsx`

**Interfaces:**
- Consumes: `PublicArticlesResponse`, `PublicArticleDetail` from `@support/types`; `apiCall` from `frontend/src/api/httpClient.ts`.
- Produces: `buildArticleSearchParams({ q, intentId }): URLSearchParams` (pure helper, tested directly, used by `ArticleList.tsx` to build the query string for `/surface/articles`).

- [ ] **Step 1: Write the failing test for the pure query-builder**

Create `frontend/src/pages/articleSearch.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { buildArticleSearchParams } from './articleSearch.ts'

describe('buildArticleSearchParams', () => {
  it('omits absent filters entirely', () => {
    expect(buildArticleSearchParams({}).toString()).toBe('')
  })

  it('includes q when present and trimmed non-empty', () => {
    expect(buildArticleSearchParams({ q: '  refund  ' }).toString()).toBe('q=refund')
  })

  it('drops a blank q', () => {
    expect(buildArticleSearchParams({ q: '   ' }).toString()).toBe('')
  })

  it('includes intentId when present', () => {
    expect(buildArticleSearchParams({ intentId: 'abc-123' }).toString()).toBe('intentId=abc-123')
  })

  it('includes both when both are present', () => {
    const params = buildArticleSearchParams({ q: 'refund', intentId: 'abc-123' })
    expect(params.get('q')).toBe('refund')
    expect(params.get('intentId')).toBe('abc-123')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @support/web test -- articleSearch.test.ts`
Expected: FAIL — `./articleSearch.ts` does not exist yet.

- [ ] **Step 3: Implement the pure helper**

Create `frontend/src/pages/articleSearch.ts`:

```typescript
export function buildArticleSearchParams(filter: { q?: string; intentId?: string }): URLSearchParams {
  const params = new URLSearchParams()
  const q = filter.q?.trim()
  if (q) params.set('q', q)
  if (filter.intentId) params.set('intentId', filter.intentId)
  return params
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @support/web test -- articleSearch.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the public API client**

Create `frontend/src/api/articlesApi.ts`:

```typescript
import type { PublicArticleDetail, PublicArticlesResponse } from '@support/types'
import { apiCall } from './httpClient.ts'
import { buildArticleSearchParams } from '../pages/articleSearch.ts'

export function fetchPublicArticles(
  token: string,
  filter: { q?: string; intentId?: string } = {},
): Promise<PublicArticlesResponse> {
  const params = buildArticleSearchParams(filter)
  const query = params.toString()
  return apiCall(`/surface/articles${query ? `?${query}` : ''}`, token)
}

export function fetchPublicArticle(token: string, id: string): Promise<PublicArticleDetail> {
  return apiCall(`/surface/articles/${id}`, token)
}
```

- [ ] **Step 6: Build ArticleList**

Create `frontend/src/pages/ArticleList.tsx`. It follows `SupportSurface.tsx`'s pattern of reading the boot token/session from the URL (see `frontend/src/boot.ts`) rather than `loadAgentSession()`, since this is a player-facing page:

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { fetchPublicArticles } from '../api/articlesApi.ts'
import { readBoot } from '../boot.ts'

export function ArticleList() {
  const navigate = useNavigate()
  const boot = readBoot(window.location)
  const [q, setQ] = useState('')

  const articles = useQuery({
    queryKey: ['public-articles', q],
    queryFn: () => fetchPublicArticles(boot!.token, { q: q || undefined }),
    enabled: boot !== null,
  })

  if (!boot) return <p>Missing support session.</p>

  return (
    <main className="article-list">
      <h1>Help articles</h1>
      <input placeholder="Search articles" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>
        {articles.data?.articles.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => navigate(`/articles/${a.id}`)}>
              {a.title}
            </button>
          </li>
        ))}
      </ul>
      {articles.data?.articles.length === 0 && <p>No articles found.</p>}
    </main>
  )
}
```

- [ ] **Step 7: Build ArticleView**

Create `frontend/src/pages/ArticleView.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { fetchPublicArticle } from '../api/articlesApi.ts'
import { readBoot } from '../boot.ts'

export function ArticleView() {
  const { id } = useParams<{ id: string }>()
  const boot = readBoot(window.location)

  const article = useQuery({
    queryKey: ['public-article', id],
    queryFn: () => fetchPublicArticle(boot!.token, id!),
    enabled: boot !== null && id !== undefined,
  })

  if (!boot) return <p>Missing support session.</p>
  if (article.isLoading) return <p>Loading…</p>
  if (article.isError || !article.data) return <p>Article not found.</p>

  return (
    <main className="article-view">
      <h1>{article.data.title}</h1>
      <article>{article.data.body}</article>
    </main>
  )
}
```

- [ ] **Step 8: Wire the routes**

Edit `frontend/src/routes.tsx`:

```tsx
import { Route, Routes } from 'react-router-dom'
import { SupportSurface } from './pages/SupportSurface.tsx'
import { AgentLogin } from './pages/AgentLogin.tsx'
import { AgentInbox } from './pages/AgentInbox.tsx'
import { AgentConversation } from './pages/AgentConversation.tsx'
import { AdminArticles } from './pages/AdminArticles.tsx'
import { ArticleList } from './pages/ArticleList.tsx'
import { ArticleView } from './pages/ArticleView.tsx'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<SupportSurface />} />
      <Route path="/login" element={<AgentLogin />} />
      <Route path="/inbox" element={<AgentInbox />} />
      <Route path="/conversations/:id" element={<AgentConversation />} />
      <Route path="/admin/articles" element={<AdminArticles />} />
      <Route path="/articles" element={<ArticleList />} />
      <Route path="/articles/:id" element={<ArticleView />} />
    </Routes>
  )
}
```

*(If Task 4 already edited this file, resolve the two-hunk merge — each adds one non-overlapping `<Route>` line and one non-overlapping import.)*

- [ ] **Step 9: Typecheck and run the frontend suite**

Run: `pnpm --filter @support/web typecheck`
Run: `pnpm --filter @support/web test`
Expected: both PASS.

- [ ] **Step 10: Manual check in the browser**

Run: `pnpm dev`, open the support surface with a valid boot URL (session id in query, token in fragment — see `SupportSurface.tsx`/`boot.ts` for how one is constructed in dev), navigate to `/articles`, confirm published articles list and search filters them, click one, confirm `/articles/:id` renders its body, and confirm a draft/archived article's id 404s if hit directly.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/pages/articleSearch.ts frontend/src/pages/articleSearch.test.ts \
  frontend/src/api/articlesApi.ts frontend/src/pages/ArticleList.tsx frontend/src/pages/ArticleView.tsx \
  frontend/src/routes.tsx
git commit -m "feat: public article list and view pages"
```

---

## Final verification (after all five tasks land)

- [ ] Run `pnpm test` (full monorepo suite) — PASS.
- [ ] Run `pnpm typecheck` — PASS.
- [ ] Run `pnpm db:setup` from a clean database — PASS, confirms the schema migration is idempotent and complete.
- [ ] Open `http://localhost:4000/docs` and confirm all eleven new paths (`/agent/intents`, `/agent/intents/{id}/subintents`, `/agent/articles*` ×5, `/surface/articles`, `/surface/articles/{id}`) render with correct request/response shapes.
- [ ] Do not use an AI reviewer for this verification pass — the Vitest suites plus the manual `/docs` and browser checks above are the source of truth per the project's testing section.
