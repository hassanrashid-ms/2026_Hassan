# Articles Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins edit a published article via a staged draft, publish it as a new
version, discard an in-progress draft, and browse/diff/restore prior versions.

**Architecture:** One new table, `article_version`, doubles as both the draft store
(rows with `status='draft'`) and the append-only version history (`status='published'`),
plus a `'discarded'` terminal status for abandoned drafts (never deleted — the app's DB
role has no `DELETE` grant on anything). `article.title/body/keywords` stay the single
source of truth for live content everywhere else in the codebase (player surface, bot
grounding, Weaviate index) — publishing copies the draft row's content onto `article`
and flips the draft row to `published`, it never introduces a join into any existing
read path.

**Tech Stack:** Express 5 + Zod, Drizzle ORM + drizzle-kit migrations, Postgres RLS,
Weaviate, React + TanStack Query + shadcn/ui, `@support/types` shared contract.

**Design doc:** `docs/specs/2026-08-28-articles-versioning-design.md` — read it first.
This plan implements it exactly; if anything here seems to contradict it, the spec
wins and this plan has a bug.

## Global Constraints

- Tailwind v4 utilities only — no hand-written CSS classes (repo CLAUDE.md).
- No hard deletes anywhere; `support_app` has no `DELETE` grant on any table
  (`backend/src/shared/db/sql/002_rls.sql`) — this is why discard uses a status flag,
  not a delete.
- Every scoped table needs an RLS policy; every request sets
  `app.workspace_id` via `select set_config(...)`.
- New routes' Zod schemas must be registered in `backend/src/docs/openapi.ts`.
- Publishing is Team Lead/Admin only (`requireTeamLeadOrAdmin`), same split as today's
  publish/archive.
- Never `console.*` — use `logger` from `backend/src/shared/logging/logger.ts` (not
  needed in this feature's code paths, but don't introduce a violation).
- Run `pnpm db:generate` after schema changes and commit the generated migration file;
  run `pnpm db:setup` to apply it locally before running tests.

---

### Task 1: Schema — `article_version` table, `article.version`, attachment staging columns

**Files:**
- Modify: `backend/src/shared/db/schema/articles.ts`
- Modify: `backend/src/shared/db/sql/002_rls.sql`
- Create (generated): `backend/drizzle/00XX_article_version.sql` (via `pnpm db:generate`)
- Create: `backend/drizzle/00XX_article_version_append_only_trigger.sql` (hand-written,
  next number after the generated one)
- Create: `backend/drizzle/00XX_backfill_article_version.sql` (hand-written, next
  number after that)
- Test: `backend/tests/schema.article-version.test.ts`

**Interfaces:**
- Produces: `article` gains column `version: integer` (Drizzle: `article.version`).
  `articleAttachment` gains `draftOnly: boolean`, `pendingRemovalAt: timestamp | null`,
  `removedAt: timestamp | null`. New export `articleVersion` (Drizzle table) with
  columns `id, articleId, status, version, title, body, keywords, attachmentIds,
  actorId, changedFields, createdAt, updatedAt`, `status` is a new pgEnum
  `articleVersionStatus = ['draft', 'published', 'discarded']`.

- [ ] **Step 1: Add the enum and `article_version` table to the schema**

Add to `backend/src/shared/db/schema/enums.ts` (append after `articleState`, line 44):

```typescript
export const articleVersionStatus = pgEnum('article_version_status', [
  'draft',
  'published',
  'discarded',
]);
```

Rewrite `backend/src/shared/db/schema/articles.ts` in full:

```typescript
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { articleState, articleVersionStatus } from './enums.ts';
import { agent, workspace } from './identity.ts';
import { intent } from './taxonomy.ts';

const tz = { withTimezone: true, mode: 'date' } as const;

export const article = pgTable('article', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  intentId: uuid('intent_id').references(() => intent.id, { onDelete: 'restrict' }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  keywords: text('keywords').array().notNull().default([]),
  state: articleState('state').notNull().default('draft'),
  /**
   * Cached current live version number, updated alongside title/body/keywords on
   * every publish. Lets list/detail views show "v{N}" with no join into
   * article_version. Meaningless (stays at its default) until the article's first
   * publish.
   */
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => agent.id, { onDelete: 'restrict' }),
  publishedBy: uuid('published_by').references(() => agent.id, { onDelete: 'restrict' }),
  publishedAt: timestamp('published_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

/**
 * No row exists until the object is HEAD-verified and claimed — same convention as
 * chat's `attachment` table (conversations.ts). Mirrors it exactly: no `status`
 * column, `storageKey` required from the start.
 *
 * `draftOnly`/`pendingRemovalAt`/`removedAt` stage attachment changes made while an
 * article's draft is being edited (see article_version below): a `draftOnly`
 * attachment isn't live yet, a `pendingRemovalAt` one is still live but staged for
 * removal, and `removedAt` is the final soft-removed state — never a DELETE.
 */
export const articleAttachment = pgTable('article_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  storageKey: text('storage_key').notNull(),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  draftOnly: boolean('draft_only').notNull().default(false),
  pendingRemovalAt: timestamp('pending_removal_at', tz),
  removedAt: timestamp('removed_at', tz),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});

/**
 * Doubles as the draft store AND the version history — see
 * docs/specs/2026-08-28-articles-versioning-design.md. Exactly one `status='draft'`
 * row may exist per articleId (partial unique index below); `status='published'` rows
 * are the append-only history, one per publish; `status='discarded'` is where an
 * abandoned draft ends up (never deleted — support_app has no DELETE grant, see
 * 002_rls.sql).
 *
 * `version` is null while `status='draft'`, assigned as MAX(published version)+1 only
 * at publish time, inside the same transaction as the article/attachment writes.
 *
 * Published rows are append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger
 * (see the hand-written article_version_append_only_trigger migration) rather than a
 * blanket REVOKE UPDATE on the table, since draft rows must stay mutable.
 */
export const articleVersion = pgTable(
  'article_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    articleId: uuid('article_id')
      .notNull()
      .references(() => article.id, { onDelete: 'restrict' }),
    status: articleVersionStatus('status').notNull().default('draft'),
    version: integer('version'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    keywords: text('keywords').array().notNull().default([]),
    attachmentIds: uuid('attachment_ids').array().notNull().default([]),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => agent.id, { onDelete: 'restrict' }),
    /** Subset of 'title' | 'body' | 'keywords' | 'attachments' — computed at publish time. */
    changedFields: text('changed_fields').array().notNull().default([]),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (t) => [
    unique('article_version_article_version_unique').on(t.articleId, t.version),
    index('article_version_article_created_idx').on(t.articleId, t.createdAt),
  ],
);
```

Note: Postgres allows multiple rows with a NULL in a unique index by default, so
`unique(articleId, version)` does not block multiple `version=null` draft rows for the
same article — but the app-level invariant ("at most one `status='draft'` row per
article") still needs its own partial index, added in Step 2's raw SQL, since Drizzle's
schema builder here doesn't express a `WHERE` clause on `unique()`.

- [ ] **Step 2: Generate the migration, then hand-add the partial index and trigger**

Run:
```bash
pnpm db:generate
```

This produces `backend/drizzle/00XX_<generated_name>.sql` with the `CREATE TYPE
article_version_status`, `ALTER TABLE article ADD COLUMN version`, `ALTER TABLE
article_attachment ADD COLUMN draft_only/pending_removal_at/removed_at`, and `CREATE
TABLE article_version` statements. Open it and confirm it looks like this shape (exact
column/constraint names may differ slightly — drizzle-kit names FKs/indexes
deterministically from the schema, so trust its output over hand-typing this):

```sql
CREATE TYPE "public"."article_version_status" AS ENUM('draft', 'published', 'discarded');
--> statement-breakpoint
ALTER TABLE "article" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "draft_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "pending_removal_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "article_attachment" ADD COLUMN "removed_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "article_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"status" "article_version_status" DEFAULT 'draft' NOT NULL,
	"version" integer,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"keywords" text[] DEFAULT '{}' NOT NULL,
	"attachment_ids" uuid[] DEFAULT '{}' NOT NULL,
	"actor_id" uuid NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_version_article_version_unique" UNIQUE("article_id","version")
);
--> statement-breakpoint
ALTER TABLE "article_version" ADD CONSTRAINT "article_version_article_id_article_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."article"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "article_version" ADD CONSTRAINT "article_version_actor_id_agent_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agent"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "article_version_article_created_idx" ON "article_version" USING btree ("article_id","created_at");
```

If drizzle-kit's output differs cosmetically (constraint names, statement order),
leave its generated file as-is — do not hand-edit it.

Create `backend/drizzle/00XX_article_version_append_only_trigger.sql` (number = the
generated migration's number + 1):

```sql
-- Published article_version rows are append-only, same reasoning as change_log and
-- bot_config_version — but unlike those tables, this one also holds mutable draft
-- rows (status='draft'), so a blanket REVOKE UPDATE would break draft editing. A
-- per-row trigger enforces "published rows never change" precisely instead.
CREATE OR REPLACE FUNCTION prevent_published_article_version_mutation()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'article_version rows with status=published are append-only';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER article_version_append_only
BEFORE UPDATE OR DELETE ON article_version
FOR EACH ROW EXECUTE FUNCTION prevent_published_article_version_mutation();

-- At most one in-progress draft per article.
CREATE UNIQUE INDEX article_version_one_draft_per_article
ON article_version (article_id)
WHERE status = 'draft';
```

Create `backend/drizzle/00XX_backfill_article_version.sql` (number = trigger
migration's number + 1) — mirrors `0023_backfill_bot_config_version.sql`'s shape:

```sql
-- BACKFILL — existing published articles predate article_version. Without this,
-- their History tab would be permanently empty: the first post-deploy edit's publish
-- would mint v1 from the POST-edit state, discarding the fact that the article was
-- ever live before this feature shipped.
--
-- Idempotent: only inserts a v1 row for a published article with no article_version
-- row at all.
INSERT INTO "article_version"
  ("article_id", "status", "version", "title", "body", "keywords", "attachment_ids",
   "actor_id", "changed_fields", "created_at")
SELECT
  a."id",
  'published',
  1,
  a."title",
  a."body",
  a."keywords",
  COALESCE(
    (SELECT array_agg(aa."id") FROM "article_attachment" aa
     WHERE aa."article_id" = a."id" AND aa."removed_at" IS NULL AND aa."draft_only" = false),
    '{}'
  ),
  a."published_by",
  ARRAY['title', 'body', 'keywords'],
  a."published_at"
FROM "article" a
WHERE a."state" = 'published'
  AND a."published_by" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "article_version" av WHERE av."article_id" = a."id"
  );

UPDATE "article" a SET "version" = 1
WHERE a."state" = 'published'
  AND EXISTS (
    SELECT 1 FROM "article_version" av
    WHERE av."article_id" = a."id" AND av."version" = 1
  );
```

- [ ] **Step 3: Add the RLS policy and grants for `article_version`**

Open `backend/src/shared/db/sql/002_rls.sql`. Find where `article` and
`article_attachment` get their tenant policy (search for `'article'` in the loop that
applies `CREATE POLICY tenant ON %I` — it iterates a table list). `article_version` has
no `workspace_id` column of its own, so it can't join that generic loop the same way;
add an explicit policy instead, right after the `article`/`article_attachment` entries:

```sql
-- article_version has no workspace_id column — scope through article_id instead.
ALTER TABLE article_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON article_version
  USING (
    article_id IN (
      SELECT id FROM article WHERE workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  )
  WITH CHECK (
    article_id IN (
      SELECT id FROM article WHERE workspace_id = current_setting('app.workspace_id', true)::uuid
    )
  );
```

(Read the surrounding file first to match the exact `current_setting`/cast idiom
already used elsewhere in this file — copy that idiom rather than retyping it, so a
future change to how `app.workspace_id` is read only has one place to update.)

- [ ] **Step 4: Apply the migrations locally**

Run:
```bash
pnpm db:setup
```
Expected: completes without error. If the trigger or backfill SQL has a typo, this is
where it surfaces.

- [ ] **Step 5: Write a schema-level test for the trigger and partial index**

Create `backend/tests/schema.article-version.test.ts`:

```typescript
import { afterAll, describe, expect, it } from 'vitest';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

afterAll(async () => {
  await closeOwnerPool();
});

async function seedAgentRow(): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ($1, 'Test Agent') returning id`,
    [`agent-${Math.random().toString(36).slice(2)}@example.test`],
  );
  return rows[0]!.id;
}

async function seedArticleRow(workspaceId: string, agentId: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into article (workspace_id, title, body, created_by) values ($1, 'X', 'Y', $2) returning id`,
    [workspaceId, agentId],
  );
  return rows[0]!.id;
}

describe('article_version constraints', () => {
  it('rejects a second draft row for the same article', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentRow();
    const articleId = await seedArticleRow(workspaceId, agentId);

    await ownerPool.query(
      `insert into article_version (article_id, status, title, body, actor_id) values ($1, 'draft', 'A', 'B', $2)`,
      [articleId, agentId],
    );
    await expect(
      ownerPool.query(
        `insert into article_version (article_id, status, title, body, actor_id) values ($1, 'draft', 'C', 'D', $2)`,
        [articleId, agentId],
      ),
    ).rejects.toThrow();
  });

  it('rejects updating a published row', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentRow();
    const articleId = await seedArticleRow(workspaceId, agentId);

    await ownerPool.query(
      `insert into article_version (article_id, status, version, title, body, actor_id, changed_fields) values ($1, 'published', 1, 'A', 'B', $2, ARRAY['title'])`,
      [articleId, agentId],
    );
    await expect(
      ownerPool.query(`update article_version set title = 'Z' where article_id = $1`, [articleId]),
    ).rejects.toThrow(/append-only/);
  });

  it('allows updating a draft row', async () => {
    await truncateAll();
    const workspaceId = await seedWorkspace();
    const agentId = await seedAgentRow();
    const articleId = await seedArticleRow(workspaceId, agentId);

    await ownerPool.query(
      `insert into article_version (article_id, status, title, body, actor_id) values ($1, 'draft', 'A', 'B', $2)`,
      [articleId, agentId],
    );
    await ownerPool.query(`update article_version set title = 'Z' where article_id = $1`, [
      articleId,
    ]);
    const { rows } = await ownerPool.query(`select title from article_version where article_id = $1`, [
      articleId,
    ]);
    expect(rows[0].title).toBe('Z');
  });
});
```

Run: `pnpm --filter @support/api test schema.article-version`
Expected: all three tests PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/db/schema/articles.ts backend/src/shared/db/schema/enums.ts \
  backend/src/shared/db/sql/002_rls.sql backend/drizzle backend/tests/schema.article-version.test.ts
git commit -m "Add article_version table, article.version, attachment staging columns"
```

---

### Task 2: `@support/types` — versioning types and request/response shapes

**Files:**
- Modify: `packages/types/src/articles.ts`
- Test: none (pure types + Zod schemas; exercised by Task 3+ tests)

**Interfaces:**
- Consumes: nothing new.
- Produces (all imported as `@support/types` by later tasks):
  `ArticleVersionedField`, `ArticleVersionActorView`, `ArticleVersionSummaryView`,
  `ArticleVersionSnapshotView`, `ArticleVersionsListResponse`, `SaveArticleDraftBody`,
  `RestoreArticleVersionBody` (empty body — kept for symmetry/future use, currently
  unused fields), `ArticleVersionsQuery`.

- [ ] **Step 1: Add the types**

Append to `packages/types/src/articles.ts` (after `PublicArticleDetail`):

```typescript
export const ARTICLE_VERSIONED_FIELDS = ['title', 'body', 'keywords', 'attachments'] as const;
export type ArticleVersionedField = (typeof ARTICLE_VERSIONED_FIELDS)[number];

export type ArticleVersionActorView = { id: string; display_name: string; email: string };

/** One row in the version list — no full snapshot payload, kept light for paging. */
export type ArticleVersionSummaryView = {
  version: number;
  actor: ArticleVersionActorView;
  changed_fields: ArticleVersionedField[];
  created_at: string;
};

export type ArticleVersionsListResponse = {
  versions: ArticleVersionSummaryView[];
  next_cursor: number | null;
};

/** Full snapshot for one version — fetched on demand when a row is expanded. */
export type ArticleVersionSnapshotView = ArticleVersionSummaryView & {
  title: string;
  body: string;
  keywords: string[];
  attachments: ArticleAttachmentView[];
};

export const ArticleVersionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().positive().optional(),
});

export const SaveArticleDraftBody = z.object({
  title: z.string().max(200).optional(),
  body: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

/** Draft state included in AgentArticleDetail so the editor can show the banner/badge. */
export type ArticleDraftView = {
  title: string;
  body: string;
  keywords: string[];
  attachments: ArticleAttachmentView[];
  updated_at: string;
} | null;
```

Update the existing `AgentArticleDetail` type in the same file to add the draft and
live-version fields:

```typescript
export type AgentArticleDetail = {
  id: string;
  title: string;
  body: string;
  keywords: string[];
  state: ArticleStateValue;
  version: number;
  intent_id: string | null;
  created_by: string;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
  attachments: ArticleAttachmentView[];
  draft: ArticleDraftView;
};
```

And `AgentArticleSummary` (used by the list view) gains `version`:

```typescript
export type AgentArticleSummary = {
  id: string;
  title: string;
  body: string;
  state: ArticleStateValue;
  version: number;
  has_draft: boolean;
  intent_id: string | null;
  created_at: string;
  published_at: string | null;
};
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @support/types typecheck`
Expected: passes (nothing consumes the new/changed fields yet, so no downstream break
here — Task 3 fixes the backend service to match `AgentArticleDetail`'s new required
fields).

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/articles.ts
git commit -m "Add article versioning types to @support/types"
```

---

### Task 3: Backend service — `saveArticleDraft` and `discardArticleDraft`

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Test: `backend/tests/agent.articles.test.ts`

**Interfaces:**
- Consumes: `articleVersion` table (Task 1), `AgentArticleDetail`/`ArticleDraftView`
  types (Task 2).
- Produces: `saveArticleDraft(ctx, articleId, patch): Promise<SaveArticleDraftResult>`,
  `discardArticleDraft(ctx, articleId): Promise<DiscardArticleDraftResult>`, and a
  `draftFor(tx, articleId): Promise<ArticleDraftView>` helper later tasks reuse.
  `toDetail` is updated to include `version` and `draft`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/agent.articles.test.ts` (new `describe` block, after the existing
`draft -> publish -> archive` block):

```typescript
describe('draft overlay on a published article', () => {
  async function publishedArticle(workspaceId: string, token: string) {
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Original title', body: 'Original body' })
      .expect(201);
    await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    return created.body.id as string;
  }

  it('saves a draft on a published article without touching live content', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const id = await publishedArticle(workspaceId, token);

    const res = await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Edited title' })
      .expect(200);

    expect(res.body.draft).toMatchObject({ title: 'Edited title' });
    expect(res.body.title).toBe('Original title');
    expect(res.body.state).toBe('published');
  });

  it('409s saving a draft on an article that is not published', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);

    await request(app)
      .patch(`/articles/${created.body.id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Z' })
      .expect(409);
  });

  it('upserts the same draft row across repeated saves', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const id = await publishedArticle(workspaceId, token);

    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'First edit' })
      .expect(200);
    const second = await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ body: 'Second edit body' })
      .expect(200);

    expect(second.body.draft).toMatchObject({ title: 'First edit', body: 'Second edit body' });
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from article_version where article_id = $1 and status = 'draft'`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('discards a draft, clearing it without touching live content', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const id = await publishedArticle(workspaceId, token);
    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'Edited title' })
      .expect(200);

    const res = await request(app)
      .delete(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.draft).toBeNull();
    expect(res.body.title).toBe('Original title');
    const { rows } = await ownerPool.query(
      `select status from article_version where article_id = $1`,
      [id],
    );
    expect(rows[0].status).toBe('discarded');
  });
});
```

- [ ] **Step 2: Run to verify these fail**

Run: `pnpm --filter @support/api test agent.articles`
Expected: FAIL — `PATCH /articles/:id/draft` and `DELETE /articles/:id/draft` are 404
(routes don't exist yet; wired in Task 7). For now, run only the schema-level
assertions won't apply — this whole block will fail at the request level until Task 7.
**This is expected and fine to leave red until Task 7's wiring lands** — write the
service functions now (Steps 3+), and re-run this exact test file at the end of Task 7
to confirm green. Note this in the task handoff so the next task's implementer isn't
surprised by red tests they didn't cause.

- [ ] **Step 3: Implement `draftFor`, `saveArticleDraft`, `discardArticleDraft`, and
      update `toDetail`**

In `backend/src/agent/services/articlesService.ts`:

Replace the import line to add `articleVersion` and the new types:

```typescript
import type {
  AgentArticleDetail,
  AgentArticlesResponse,
  ArticleAttachmentView,
  ArticleDraftView,
  FinalizeArticleAttachmentBody,
} from '@support/types';
import { article, articleAttachment, articleVersion, intent } from '../../shared/db/schema/index.ts';
```

Add `draftFor` right after `attachmentsFor` (which stays unchanged):

```typescript
async function draftFor(tx: Tx, articleId: string): Promise<ArticleDraftView> {
  const [draft] = await tx
    .select()
    .from(articleVersion)
    .where(and(eq(articleVersion.articleId, articleId), eq(articleVersion.status, 'draft')))
    .limit(1);
  if (!draft) return null;

  const attachmentRows = await tx
    .select()
    .from(articleAttachment)
    .where(
      and(
        eq(articleAttachment.articleId, articleId),
        isNull(articleAttachment.removedAt),
        or(isNull(articleAttachment.pendingRemovalAt), eq(articleAttachment.draftOnly, true)),
      ),
    );
  const attachments = await Promise.all(
    attachmentRows.map(async (a) => ({
      id: a.id,
      filename: a.filename,
      mime_type: a.mimeType,
      byte_size: a.byteSize,
      url: await presignGetObject(a.storageKey).catch(() => null),
    })),
  );

  return {
    title: draft.title,
    body: draft.body,
    keywords: draft.keywords,
    attachments,
    updated_at: draft.updatedAt.toISOString(),
  };
}
```

Update `toDetail` to include `version` (drop the `Omit<..., 'attachments'>` — it now
also omits `draft`, computed separately since it needs a query):

```typescript
function toDetail(row: typeof article.$inferSelect): Omit<AgentArticleDetail, 'attachments' | 'draft'> {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    keywords: row.keywords,
    state: row.state,
    version: row.version,
    intent_id: row.intentId,
    created_by: row.createdBy,
    published_by: row.publishedBy,
    published_at: row.publishedAt ? row.publishedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}
```

Every call site that builds an `AgentArticleDetail` from `toDetail(row)` (in
`getArticle`, `createArticle`, `updateArticle`, `publishArticle`, `archiveArticle`) now
needs a `draft` field too. Update each to add `draft: await draftFor(tx, id)` (or
`draft: null` in `createArticle`, since a just-created article has no draft) alongside
the existing `attachments: await attachmentsFor(tx, id)` spread. For example,
`getArticle` becomes:

```typescript
export async function getArticle(
  ctx: AgentContext,
  id: string,
): Promise<AgentArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!row) return null;

    return {
      ...toDetail(row),
      attachments: await attachmentsFor(tx, id),
      draft: await draftFor(tx, id),
    };
  });
}
```

Apply the same `draft: await draftFor(tx, id)` addition to `updateArticle`,
`publishArticle`, and `archiveArticle`'s return statements; `createArticle` gets
`draft: null` (no query needed — the row didn't exist a moment ago).

Add the new service functions after `updateArticle`:

```typescript
export type SaveArticleDraftInput = { title?: string; body?: string; keywords?: string[] };
export type SaveArticleDraftResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'not_published' };

export async function saveArticleDraft(
  ctx: AgentContext,
  id: string,
  patch: SaveArticleDraftInput,
): Promise<SaveArticleDraftResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'published') return { ok: false, reason: 'not_published' };

    const [current] = await tx
      .select()
      .from(articleVersion)
      .where(and(eq(articleVersion.articleId, id), eq(articleVersion.status, 'draft')))
      .limit(1);

    if (current) {
      await tx
        .update(articleVersion)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.keywords !== undefined ? { keywords: patch.keywords } : {}),
          actorId: ctx.agentId,
          updatedAt: new Date(),
        })
        .where(eq(articleVersion.id, current.id));
    } else {
      await tx.insert(articleVersion).values({
        articleId: id,
        status: 'draft',
        title: patch.title ?? existing.title,
        body: patch.body ?? existing.body,
        keywords: patch.keywords ?? existing.keywords,
        actorId: ctx.agentId,
      });
    }

    return {
      ok: true,
      article: {
        ...toDetail(existing),
        attachments: await attachmentsFor(tx, id),
        draft: await draftFor(tx, id),
      },
    };
  });
}

export type DiscardArticleDraftResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' | 'no_draft' };

export async function discardArticleDraft(
  ctx: AgentContext,
  id: string,
): Promise<DiscardArticleDraftResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const [draft] = await tx
      .select()
      .from(articleVersion)
      .where(and(eq(articleVersion.articleId, id), eq(articleVersion.status, 'draft')))
      .limit(1);
    if (!draft) return { ok: false, reason: 'no_draft' };

    await tx
      .update(articleVersion)
      .set({ status: 'discarded' })
      .where(eq(articleVersion.id, draft.id));
    await tx
      .update(articleAttachment)
      .set({ removedAt: new Date() })
      .where(and(eq(articleAttachment.articleId, id), eq(articleAttachment.draftOnly, true)));
    await tx
      .update(articleAttachment)
      .set({ pendingRemovalAt: null })
      .where(
        and(eq(articleAttachment.articleId, id), isNotNull(articleAttachment.pendingRemovalAt)),
      );

    return {
      ok: true,
      article: {
        ...toDetail(existing),
        attachments: await attachmentsFor(tx, id),
        draft: null,
      },
    };
  });
}
```

Update the `drizzle-orm` import line to add the new operators used above:

```typescript
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
```

- [ ] **Step 4: Run the full articles test file**

Run: `pnpm --filter @support/api test agent.articles`
Expected: the pre-existing tests (create/patch/publish/archive) still PASS — `toDetail`
now needs `draft`/`version`, which every call site provides. The four new
draft-overlay tests remain FAIL (404) until Task 7 wires the routes — confirm the
*failure reason* is 404, not a 500/type error, so Task 7 has a clean baseline.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/tests/agent.articles.test.ts
git commit -m "Add saveArticleDraft/discardArticleDraft service functions"
```

---

### Task 4: Backend service — rewrite `publishArticle` to promote a draft

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Test: `backend/tests/agent.articles.test.ts`

**Interfaces:**
- Consumes: `saveArticleDraft`/`draftFor` from Task 3.
- Produces: `publishArticle` behavior change — same signature and `PublishArticleResult`
  type, new branch when a draft exists.

- [ ] **Step 1: Write the failing tests**

Add to the `draft overlay on a published article` describe block from Task 3:

```typescript
it('publishing a draft bumps the version and clears the draft', async () => {
  const workspaceId = await seedWorkspace();
  const { token } = await seedAgent(workspaceId, 'team_lead');
  const id = await publishedArticle(workspaceId, token);
  await request(app)
    .patch(`/articles/${id}/draft`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ title: 'v2 title', body: 'v2 body' })
    .expect(200);

  const res = await request(app)
    .post(`/articles/${id}/publish`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .expect(200);

  expect(res.body.title).toBe('v2 title');
  expect(res.body.version).toBe(2);
  expect(res.body.draft).toBeNull();
  expect(upsertArticleObject).toHaveBeenCalledWith(
    expect.objectContaining({ id, title: 'v2 title', body: 'v2 body' }),
  );

  const { rows } = await ownerPool.query(
    `select version, status, changed_fields from article_version where article_id = $1 order by created_at`,
    [id],
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ version: 1, status: 'published' });
  expect(rows[1]).toMatchObject({ version: 2, status: 'published' });
  expect(rows[1].changed_fields.sort()).toEqual(['body', 'title']);
});

it('publishing with no draft is a no-op for version history (first-ever publish only)', async () => {
  const workspaceId = await seedWorkspace();
  const { token } = await seedAgent(workspaceId, 'team_lead');
  const created = await request(app)
    .post('/articles')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ title: 'X', body: 'Y' })
    .expect(201);

  await request(app)
    .post(`/articles/${created.body.id}/publish`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .expect(200);

  const { rows } = await ownerPool.query(
    `select version, status from article_version where article_id = $1`,
    [created.body.id],
  );
  expect(rows).toEqual([{ version: 1, status: 'published' }]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @support/api test agent.articles`
Expected: FAIL — first test's `version` is `1` (draft never promoted, still stuck at
default), second test's insert never happens (current `publishArticle` doesn't touch
`article_version` at all).

- [ ] **Step 3: Rewrite `publishArticle`**

Replace the existing `publishArticle` function in
`backend/src/agent/services/articlesService.ts`:

```typescript
export async function publishArticle(ctx: AgentContext, id: string): Promise<PublishArticleResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const [draftRow] = await tx
      .select()
      .from(articleVersion)
      .where(and(eq(articleVersion.articleId, id), eq(articleVersion.status, 'draft')))
      .limit(1);

    if (!draftRow) {
      // First-ever publish: existing draft-state-article flow, unchanged, plus a v1
      // version row.
      if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };
      if (existing.title.trim() === '' || existing.body.trim() === '')
        return { ok: false, reason: 'empty_fields' };

      const [row] = await tx
        .update(article)
        .set({ state: 'published', publishedBy: ctx.agentId, publishedAt: new Date(), version: 1 })
        .where(eq(article.id, id))
        .returning();
      const liveAttachmentIds = await liveAttachmentIdsFor(tx, id);
      await tx.insert(articleVersion).values({
        articleId: id,
        status: 'published',
        version: 1,
        title: row!.title,
        body: row!.body,
        keywords: row!.keywords,
        attachmentIds: liveAttachmentIds,
        actorId: ctx.agentId,
        changedFields: ['title', 'body', 'keywords'],
      });
      await upsertArticleObject({
        id: row!.id,
        title: row!.title,
        body: row!.body,
        keywords: row!.keywords,
        intentId: row!.intentId,
        workspaceId: row!.workspaceId,
      });
      return {
        ok: true,
        article: {
          ...toDetail(row!),
          attachments: await attachmentsFor(tx, id),
          draft: null,
        },
      };
    }

    // Promoting a draft on an already-published article.
    if (draftRow.title.trim() === '' || draftRow.body.trim() === '')
      return { ok: false, reason: 'empty_fields' };

    const changedFields: string[] = [];
    if (draftRow.title !== existing.title) changedFields.push('title');
    if (draftRow.body !== existing.body) changedFields.push('body');
    if (JSON.stringify(draftRow.keywords) !== JSON.stringify(existing.keywords))
      changedFields.push('keywords');

    await tx
      .update(articleAttachment)
      .set({ draftOnly: false })
      .where(and(eq(articleAttachment.articleId, id), eq(articleAttachment.draftOnly, true)));
    await tx
      .update(articleAttachment)
      .set({ removedAt: new Date(), pendingRemovalAt: null })
      .where(
        and(eq(articleAttachment.articleId, id), isNotNull(articleAttachment.pendingRemovalAt)),
      );
    const liveAttachmentIds = await liveAttachmentIdsFor(tx, id);
    if (changedFields.length === 0 && liveAttachmentIds.length === draftRow.attachmentIds.length) {
      // Nothing actually changed (draft saved, then untouched) — still clear it, but
      // don't mint an empty version.
      await tx.update(articleVersion).set({ status: 'discarded' }).where(eq(articleVersion.id, draftRow.id));
      return {
        ok: true,
        article: { ...toDetail(existing), attachments: await attachmentsFor(tx, id), draft: null },
      };
    }
    if (liveAttachmentIds.sort().join(',') !== draftRow.attachmentIds.slice().sort().join(',')) {
      changedFields.push('attachments');
    }

    const nextVersion = existing.version + 1;
    const [row] = await tx
      .update(article)
      .set({
        title: draftRow.title,
        body: draftRow.body,
        keywords: draftRow.keywords,
        version: nextVersion,
        publishedBy: ctx.agentId,
        publishedAt: new Date(),
      })
      .where(eq(article.id, id))
      .returning();
    await tx
      .update(articleVersion)
      .set({
        status: 'published',
        version: nextVersion,
        attachmentIds: liveAttachmentIds,
        changedFields,
        actorId: ctx.agentId,
      })
      .where(eq(articleVersion.id, draftRow.id));
    await upsertArticleObject({
      id: row!.id,
      title: row!.title,
      body: row!.body,
      keywords: row!.keywords,
      intentId: row!.intentId,
      workspaceId: row!.workspaceId,
    });

    return {
      ok: true,
      article: { ...toDetail(row!), attachments: await attachmentsFor(tx, id), draft: null },
    };
  });
}
```

Add the small helper it relies on, right above `publishArticle`:

```typescript
async function liveAttachmentIdsFor(tx: Tx, articleId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: articleAttachment.id })
    .from(articleAttachment)
    .where(
      and(
        eq(articleAttachment.articleId, articleId),
        isNull(articleAttachment.removedAt),
        eq(articleAttachment.draftOnly, false),
      ),
    );
  return rows.map((r) => r.id);
}
```

Note the "attachment trigger" for the row's own trigger-guarded update: the append-only
trigger from Task 1 raises when `OLD.status = 'published'` — `draftRow` here has
`OLD.status = 'draft'`, so this `UPDATE ... SET status = 'published'` is the one legal
mutation the trigger permits, exactly at the moment it stops being a draft.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @support/api test agent.articles`
Expected: all PASS, including every pre-existing test in the file (the "no draft,
first-ever publish" branch preserves the old behavior byte-for-byte: same 409s for
`not_draft`/`empty_fields`, same Weaviate call, same rollback-on-Weaviate-failure via
the enclosing transaction).

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/tests/agent.articles.test.ts
git commit -m "Promote a draft to a new version on publish"
```

---

### Task 5: Backend service — list/get/restore versions

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Test: `backend/tests/agent.articles.test.ts`

**Interfaces:**
- Consumes: `articleVersion`, `agent` tables; `ArticleVersionSummaryView`,
  `ArticleVersionSnapshotView`, `ArticleVersionsListResponse` types (Task 2).
- Produces: `listArticleVersions(ctx, articleId, opts): Promise<ListArticleVersionsResult>`,
  `getArticleVersion(ctx, articleId, version): Promise<GetArticleVersionResult>`,
  `restoreArticleVersion(ctx, articleId, version): Promise<SaveArticleDraftResult>`
  (reuses `SaveArticleDraftResult` — restoring produces exactly the same shape as
  saving a draft).

- [ ] **Step 1: Write the failing tests**

Add a new describe block to `backend/tests/agent.articles.test.ts`:

```typescript
describe('article version history', () => {
  it('lists versions newest-first with changed fields', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v1', body: 'v1 body' })
      .expect(201);
    const id = created.body.id as string;
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v2' })
      .expect(200);
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const res = await request(app)
      .get(`/articles/${id}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.versions).toHaveLength(2);
    expect(res.body.versions[0]).toMatchObject({ version: 2, changed_fields: ['title'] });
    expect(res.body.versions[1]).toMatchObject({ version: 1 });
    expect(res.body.next_cursor).toBeNull();
  });

  it('fetches a single version snapshot', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v1', body: 'v1 body' })
      .expect(201);
    const id = created.body.id as string;
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const res = await request(app)
      .get(`/articles/${id}/versions/1`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body).toMatchObject({ version: 1, title: 'v1', body: 'v1 body' });
  });

  it('404s a version number that does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v1', body: 'v1 body' })
      .expect(201);
    await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    await request(app)
      .get(`/articles/${created.body.id}/versions/99`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(404);
  });

  it('restore loads a past version into the draft without publishing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v1', body: 'v1 body' })
      .expect(201);
    const id = created.body.id as string;
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v2' })
      .expect(200);
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const res = await request(app)
      .post(`/articles/${id}/versions/1/restore`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    expect(res.body.title).toBe('v2'); // live content untouched
    expect(res.body.version).toBe(2);
    expect(res.body.draft).toMatchObject({ title: 'v1' });
  });
});
```

- [ ] **Step 2: Run to verify these fail**

Run: `pnpm --filter @support/api test agent.articles`
Expected: FAIL with 404 (routes not wired — Task 7).

- [ ] **Step 3: Implement the three functions**

Add to `backend/src/agent/services/articlesService.ts`, after `discardArticleDraft`:

```typescript
export type ListArticleVersionsResult =
  | { ok: true; versions: ArticleVersionsListResponse }
  | { ok: false; reason: 'not_found' };

export async function listArticleVersions(
  ctx: AgentContext,
  articleId: string,
  opts: { limit: number; cursor?: number },
): Promise<ListArticleVersionsResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select({ id: article.id }).from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };

    const where =
      opts.cursor === undefined
        ? and(eq(articleVersion.articleId, articleId), eq(articleVersion.status, 'published'))
        : and(
            eq(articleVersion.articleId, articleId),
            eq(articleVersion.status, 'published'),
            lt(articleVersion.version, opts.cursor),
          );

    const found = await tx
      .select({
        version: articleVersion.version,
        createdAt: articleVersion.createdAt,
        changedFields: articleVersion.changedFields,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(articleVersion)
      .innerJoin(agent, eq(agent.id, articleVersion.actorId))
      .where(where)
      .orderBy(desc(articleVersion.version))
      .limit(opts.limit + 1);

    const page = found.slice(0, opts.limit);
    const versions = page.map((row) => ({
      version: row.version!,
      changed_fields: row.changedFields as ArticleVersionedField[],
      created_at: row.createdAt.toISOString(),
      actor: { id: row.actorId, display_name: row.actorDisplayName, email: row.actorEmail },
    }));
    const last = versions.at(-1);
    const nextCursor = found.length > opts.limit && last ? last.version : null;

    return { ok: true, versions: { versions, next_cursor: nextCursor } };
  });
}

export type GetArticleVersionResult =
  | { ok: true; version: ArticleVersionSnapshotView }
  | { ok: false; reason: 'not_found' };

export async function getArticleVersion(
  ctx: AgentContext,
  articleId: string,
  versionNumber: number,
): Promise<GetArticleVersionResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx
      .select({
        version: articleVersion.version,
        title: articleVersion.title,
        body: articleVersion.body,
        keywords: articleVersion.keywords,
        attachmentIds: articleVersion.attachmentIds,
        changedFields: articleVersion.changedFields,
        createdAt: articleVersion.createdAt,
        actorId: agent.id,
        actorDisplayName: agent.displayName,
        actorEmail: agent.email,
      })
      .from(articleVersion)
      .innerJoin(agent, eq(agent.id, articleVersion.actorId))
      .where(
        and(
          eq(articleVersion.articleId, articleId),
          eq(articleVersion.status, 'published'),
          eq(articleVersion.version, versionNumber),
        ),
      )
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };

    const attachmentRows =
      row.attachmentIds.length === 0
        ? []
        : await tx.select().from(articleAttachment).where(inArray(articleAttachment.id, row.attachmentIds));
    const attachments = await Promise.all(
      attachmentRows.map(async (a) => ({
        id: a.id,
        filename: a.filename,
        mime_type: a.mimeType,
        byte_size: a.byteSize,
        url: await presignGetObject(a.storageKey).catch(() => null),
      })),
    );

    return {
      ok: true,
      version: {
        version: row.version!,
        title: row.title,
        body: row.body,
        keywords: row.keywords,
        attachments,
        changed_fields: row.changedFields as ArticleVersionedField[],
        created_at: row.createdAt.toISOString(),
        actor: { id: row.actorId, display_name: row.actorDisplayName, email: row.actorEmail },
      },
    };
  });
}

export async function restoreArticleVersion(
  ctx: AgentContext,
  articleId: string,
  versionNumber: number,
): Promise<SaveArticleDraftResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'published') return { ok: false, reason: 'not_published' };

    const [snapshot] = await tx
      .select()
      .from(articleVersion)
      .where(
        and(
          eq(articleVersion.articleId, articleId),
          eq(articleVersion.status, 'published'),
          eq(articleVersion.version, versionNumber),
        ),
      )
      .limit(1);
    if (!snapshot) return { ok: false, reason: 'not_found' };

    return saveArticleDraft(ctx, articleId, {
      title: snapshot.title,
      body: snapshot.body,
      keywords: snapshot.keywords,
    });
  });
}
```

`SaveArticleDraftResult`'s failure union is already `'not_found' | 'not_published'`
(defined in Task 3), so this `{ ok: false, reason: 'not_found' }` return needs no
widening or cast.

Add the missing imports (`lt`, `inArray`) to the `drizzle-orm` import line:

```typescript
import { and, desc, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm';
```

And add `ArticleVersionedField`, `ArticleVersionSnapshotView`,
`ArticleVersionsListResponse` to the `@support/types` import line at the top of the
file.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @support/api test agent.articles`
Expected: the version-history tests still fail with 404 (routes come in Task 7) — but
run `pnpm --filter @support/api typecheck` now and confirm it's clean, since this
task's functions are otherwise untestable until routed.

Run: `pnpm --filter @support/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/tests/agent.articles.test.ts
git commit -m "Add listArticleVersions/getArticleVersion/restoreArticleVersion"
```

---

### Task 6: Backend — attachment staging on finalize + new remove-attachment route

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Test: `backend/tests/agent.articles.test.ts`

**Interfaces:**
- Consumes: `articleAttachment.draftOnly`/`pendingRemovalAt` (Task 1).
- Produces: `finalizeArticleAttachment` gains a `draftOnly` flag on the inserted row;
  new `removeArticleAttachment(ctx, articleId, attachmentId): Promise<RemoveArticleAttachmentResult>`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/agent.articles.test.ts`:

```typescript
describe('attachment staging during a draft edit', () => {
  it('marks an upload during draft-editing as draftOnly, not yet in attachmentsFor on the live view', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);
    const id = created.body.id as string;
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    const key = await uploadFixtureImage(workspaceId, agentId);

    await request(app)
      .post(`/articles/${id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14, draft: true })
      .expect(200);

    const { rows } = await ownerPool.query(
      `select draft_only from article_attachment where article_id = $1`,
      [id],
    );
    expect(rows[0].draft_only).toBe(true);
  });

  it('stages removal of a live attachment, only actually removed on publish', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'team_lead');
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'X', body: 'Y' })
      .expect(201);
    const id = created.body.id as string;
    const key = await uploadFixtureImage(workspaceId, agentId);
    const attachment = await request(app)
      .post(`/articles/${id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
      .expect(200);
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    await request(app)
      .delete(`/articles/${id}/attachments/${attachment.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const beforePublish = await ownerPool.query(
      `select removed_at, pending_removal_at from article_attachment where id = $1`,
      [attachment.body.id],
    );
    expect(beforePublish.rows[0].removed_at).toBeNull();
    expect(beforePublish.rows[0].pending_removal_at).not.toBeNull();

    await request(app)
      .patch(`/articles/${id}/draft`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ title: 'v2' })
      .expect(200);
    await request(app)
      .post(`/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);

    const afterPublish = await ownerPool.query(
      `select removed_at from article_attachment where id = $1`,
      [attachment.body.id],
    );
    expect(afterPublish.rows[0].removed_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify these fail**

Run: `pnpm --filter @support/api test agent.articles`
Expected: FAIL — `draft` flag on finalize is ignored (column always `false`); the
`DELETE /articles/:id/attachments/:attachmentId` route 404s (wired in Task 7).

- [ ] **Step 3: Implement**

In `backend/src/agent/services/articlesService.ts`, update
`FinalizeArticleAttachmentBody`-typed `finalizeArticleAttachment` to accept and persist
the flag. First, in `packages/types/src/articles.ts`, add `draft` to
`FinalizeArticleAttachmentBody`:

```typescript
export const FinalizeArticleAttachmentBody = z.object({
  key: z.string().min(1),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1),
  byte_size: z.number().int().positive(),
  draft: z.boolean().optional(),
});
```

Then in `articlesService.ts`, change the guard and insert in
`finalizeArticleAttachment`:

```typescript
export async function finalizeArticleAttachment(
  ctx: AgentContext,
  articleId: string,
  body: z.infer<typeof FinalizeArticleAttachmentBody>,
): Promise<FinalizeArticleAttachmentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    // Draft-state articles: unchanged, draft-only. Published articles: only
    // allowed as a draftOnly staged upload (body.draft must be true) — an
    // attachment can't land directly on the live article outside the draft flow.
    if (existing.state !== 'draft' && !(existing.state === 'published' && body.draft)) {
      return { ok: false, reason: 'not_draft' };
    }
    // ... (expectedPrefix / headObject / mismatch checks unchanged) ...

    const [row] = await tx
      .insert(articleAttachment)
      .values({
        workspaceId: ctx.workspaceId,
        articleId,
        storageKey: destKey,
        filename: body.filename,
        mimeType: body.mime_type,
        byteSize: body.byte_size,
        draftOnly: existing.state === 'published',
      })
      .returning();

    // ... (return unchanged) ...
  });
}
```

(Keep the rest of the function body exactly as it is today — only the guard condition
and the `.values({...})` object change.)

Add the new `removeArticleAttachment` function after `finalizeArticleAttachment`:

```typescript
export type RemoveArticleAttachmentResult =
  | { ok: true; article: AgentArticleDetail }
  | { ok: false; reason: 'not_found' };

export async function removeArticleAttachment(
  ctx: AgentContext,
  articleId: string,
  attachmentId: string,
): Promise<RemoveArticleAttachmentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    const [attachment] = await tx
      .select()
      .from(articleAttachment)
      .where(and(eq(articleAttachment.id, attachmentId), eq(articleAttachment.articleId, articleId)))
      .limit(1);
    if (!attachment) return { ok: false, reason: 'not_found' };

    if (existing.state === 'published' && !attachment.draftOnly) {
      // Live attachment on a published article: stage the removal, applied at publish.
      await tx
        .update(articleAttachment)
        .set({ pendingRemovalAt: new Date() })
        .where(eq(articleAttachment.id, attachmentId));
    } else {
      // Draft-state article, or a draftOnly attachment that was never live: no
      // staging needed, soft-remove now (never a DELETE).
      await tx
        .update(articleAttachment)
        .set({ removedAt: new Date() })
        .where(eq(articleAttachment.id, attachmentId));
    }

    return {
      ok: true,
      article: {
        ...toDetail(existing),
        attachments: await attachmentsFor(tx, articleId),
        draft: await draftFor(tx, articleId),
      },
    };
  });
}
```

`attachmentsFor` must exclude soft-removed and draft-only rows now — update it:

```typescript
async function attachmentsFor(tx: Tx, articleId: string): Promise<ArticleAttachmentView[]> {
  const attachmentRows = await tx
    .select()
    .from(articleAttachment)
    .where(
      and(
        eq(articleAttachment.articleId, articleId),
        isNull(articleAttachment.removedAt),
        eq(articleAttachment.draftOnly, false),
      ),
    );
  // ... (unchanged mapping) ...
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @support/api test agent.articles`
Expected: finalize-with-`draft:true` test passes. The remove-attachment test still
fails at the route level (404) — Task 7 fixes that; confirm the failure is 404, not a
type/runtime error, by checking the test output directly.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/services/articlesService.ts packages/types/src/articles.ts \
  backend/tests/agent.articles.test.ts
git commit -m "Stage attachment adds/removals during a draft edit"
```

---

### Task 7: Backend — controller, routes, OpenAPI registration

**Files:**
- Modify: `backend/src/agent/controllers/articlesController.ts`
- Modify: `backend/src/agent/routers/articlesRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.articles.test.ts` (no new tests — this task makes Tasks
  3–6's tests go green)

**Interfaces:**
- Consumes: every service function from Tasks 3–6.
- Produces: the six new HTTP endpoints listed in the design doc.

- [ ] **Step 1: Add controller handlers**

Append to `backend/src/agent/controllers/articlesController.ts` (add
`SaveArticleDraftBody`, `ArticleVersionsQuery` to the `@support/types` import, and the
new service functions to the service import):

```typescript
import {
  ArticleVersionsQuery,
  CreateArticleBody,
  FinalizeArticleAttachmentBody,
  SaveArticleDraftBody,
  UpdateArticleBody,
} from '@support/types';
// ...
import {
  archiveArticle,
  createArticle,
  discardArticleDraft,
  finalizeArticleAttachment,
  getArticle,
  getArticleVersion,
  listArticles,
  listArticleVersions,
  publishArticle,
  removeArticleAttachment,
  restoreArticleVersion,
  saveArticleDraft,
  updateArticle,
  generateKeywords,
} from '../services/articlesService.ts';
```

Add these handlers at the end of the file:

```typescript
const ArticleAttachmentParams = z.object({ id: z.uuid(), attachmentId: z.uuid() });
const ArticleVersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().positive() });

export const saveArticleDraftHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const body = SaveArticleDraftBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'Invalid draft payload.');
    return;
  }
  const result = await saveArticleDraft(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'Article is not published.');
    return;
  }
  res.status(200).json(result.article);
};

export const discardArticleDraftHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'id must be a uuid.');
    return;
  }
  const result = await discardArticleDraft(req.agent!, params.data.id);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'No draft to discard.');
    return;
  }
  res.status(200).json(result.article);
};

export const listArticleVersionsHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const query = ArticleVersionsQuery.safeParse(req.query);
  if (!params.success || !query.success) {
    sendError(res, 422, 'invalid_request', 'Invalid query.');
    return;
  }
  const result = await listArticleVersions(req.agent!, params.data.id, query.data);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article not found.');
    return;
  }
  res.status(200).json(result.versions);
};

export const getArticleVersionHandler: RequestHandler = async (req, res) => {
  const params = ArticleVersionParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'Invalid version.');
    return;
  }
  const result = await getArticleVersion(req.agent!, params.data.id, params.data.version);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Version not found.');
    return;
  }
  res.status(200).json(result.version);
};

export const restoreArticleVersionHandler: RequestHandler = async (req, res) => {
  const params = ArticleVersionParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'Invalid version.');
    return;
  }
  const result = await restoreArticleVersion(req.agent!, params.data.id, params.data.version);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article or version not found.');
      return;
    }
    sendError(res, 409, 'invalid_request', 'Article is not published.');
    return;
  }
  res.status(200).json(result.article);
};

export const removeArticleAttachmentHandler: RequestHandler = async (req, res) => {
  const params = ArticleAttachmentParams.safeParse(req.params);
  if (!params.success) {
    sendError(res, 422, 'invalid_request', 'Invalid ids.');
    return;
  }
  const result = await removeArticleAttachment(req.agent!, params.data.id, params.data.attachmentId);
  if (!result.ok) {
    sendError(res, 404, 'not_found', 'Article or attachment not found.');
    return;
  }
  res.status(200).json(result.article);
};
```

- [ ] **Step 2: Wire the routes**

In `backend/src/agent/routers/articlesRouter.ts`, import the new handlers and add the
routes (draft save/discard and attachment remove are every-role, matching the existing
draft-build split; restore and version reads are open to any role that can already
`GET /articles/:id`, since seeing/staging history is not the same privilege as
publishing):

```typescript
import { Router } from 'express';
import { requireTeamLeadOrAdmin } from '../../shared/middleware/requireTeamLeadOrAdmin.ts';
import {
  archiveArticleHandler,
  createArticleHandler,
  discardArticleDraftHandler,
  finalizeArticleAttachmentHandler,
  getArticleHandler,
  getArticleVersionHandler,
  listArticlesHandler,
  listArticleVersionsHandler,
  publishArticleHandler,
  removeArticleAttachmentHandler,
  restoreArticleVersionHandler,
  saveArticleDraftHandler,
  updateArticleHandler,
  generateKeywordsHandler,
} from '../controllers/articlesController.ts';

export const articlesRouter = Router();
articlesRouter.get('/articles', listArticlesHandler);
articlesRouter.get('/articles/:id', getArticleHandler);
articlesRouter.post('/articles', createArticleHandler);
articlesRouter.patch('/articles/:id', updateArticleHandler);
articlesRouter.patch('/articles/:id/draft', saveArticleDraftHandler);
articlesRouter.delete('/articles/:id/draft', discardArticleDraftHandler);
articlesRouter.get('/articles/:id/versions', listArticleVersionsHandler);
articlesRouter.get('/articles/:id/versions/:version', getArticleVersionHandler);
articlesRouter.post('/articles/:id/versions/:version/restore', restoreArticleVersionHandler);
// Building (create/edit a draft) is every role's; publishing and archiving —
// "putting things in front of players" / taking them away — are Team Lead +
// Admin only, same split formsRouter.ts already enforces for forms.
articlesRouter.post('/articles/:id/publish', requireTeamLeadOrAdmin, publishArticleHandler);
articlesRouter.post('/articles/:id/archive', requireTeamLeadOrAdmin, archiveArticleHandler);
articlesRouter.post('/articles/:id/attachments', finalizeArticleAttachmentHandler);
articlesRouter.delete('/articles/:id/attachments/:attachmentId', removeArticleAttachmentHandler);
articlesRouter.post('/articles/generate-keywords', generateKeywordsHandler);
```

- [ ] **Step 3: Run the full articles test suite**

Run: `pnpm --filter @support/api test agent.articles`
Expected: every test written in Tasks 3–6 now PASSES, plus all pre-existing tests still
PASS.

Run: `pnpm --filter @support/api test schema.article-version`
Expected: still PASS (unaffected by this task).

- [ ] **Step 4: Register the new routes in OpenAPI**

In `backend/src/docs/openapi.ts`, add these `registry.registerPath` blocks right after
the existing `POST /agent/articles/{id}/attachments` entry (around current line 1759,
before the "Agent Archive Article" entry — order doesn't matter functionally, but
grouping drafts/versions together keeps the doc readable):

```typescript
registry.registerPath({
  method: 'patch',
  path: '/agent/articles/{id}/draft',
  summary: 'Agent Save Article Draft',
  description:
    'Upserts the in-progress draft for a published article. 409 if the article is not published.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            title: z.string().max(200).optional(),
            body: z.string().optional(),
            keywords: z.array(z.string()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Draft saved' },
    404: { description: 'Not found' },
    409: { description: 'Article is not published' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/agent/articles/{id}/draft',
  summary: 'Agent Discard Article Draft',
  description: 'Discards the in-progress draft. Live content is untouched.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Draft discarded' },
    404: { description: 'Not found' },
    409: { description: 'No draft to discard' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/agent/articles/{id}/versions',
  summary: 'Agent List Article Versions',
  description: 'Paginated version history, newest first.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      cursor: z.coerce.number().int().positive().optional(),
    }),
  },
  responses: { 200: { description: 'Version list' }, 404: { description: 'Not found' } },
});

registry.registerPath({
  method: 'get',
  path: '/agent/articles/{id}/versions/{version}',
  summary: 'Agent Get Article Version',
  description: 'Full snapshot for one published version.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid(), version: z.coerce.number().int() }) },
  responses: { 200: { description: 'Version snapshot' }, 404: { description: 'Not found' } },
});

registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/versions/{version}/restore',
  summary: 'Agent Restore Article Version',
  description:
    'Loads a past version into the draft for review. Does not publish or touch live content.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid(), version: z.coerce.number().int() }) },
  responses: {
    200: { description: 'Draft populated from the version' },
    404: { description: 'Article or version not found' },
    409: { description: 'Article is not published' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/agent/articles/{id}/attachments/{attachmentId}',
  summary: 'Agent Remove Article Attachment',
  description:
    'On a published article with a draft in progress, stages the removal (applied at publish). Otherwise removes immediately.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ id: z.uuid(), attachmentId: z.uuid() }) },
  responses: { 200: { description: 'Removed or staged for removal' }, 404: { description: 'Not found' } },
});
```

Also update the existing `POST /agent/articles/{id}/attachments` entry's body schema
(around current line 1743) to add the `draft` field:

```typescript
schema: z.object({
  key: z.string(),
  filename: z.string().min(1).max(255),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  byte_size: z.number().int().positive(),
  draft: z.boolean().optional(),
}),
```

- [ ] **Step 5: Verify the OpenAPI doc builds**

Run: `pnpm dev` (or whatever starts the API locally), then check
`http://localhost:4000/docs/json` returns valid JSON including the six new paths. If
there's no quick way to hit this in a non-interactive check, at minimum run:

```bash
pnpm --filter @support/api typecheck
```

Expected: PASS — a malformed `registerPath` call is a type error at this schema
version.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/controllers/articlesController.ts backend/src/agent/routers/articlesRouter.ts \
  backend/src/docs/openapi.ts
git commit -m "Wire draft/discard/version-history/restore/remove-attachment routes"
```

---

### Task 8: Frontend API client

**Files:**
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Test: none (thin HTTP wrappers; exercised through Task 9/10 component tests if any
  exist, otherwise manually in Task 9/10's browser check)

**Interfaces:**
- Consumes: `@support/types` shapes from Task 2 (`AgentArticleDetail` now includes
  `draft`/`version`; new `ArticleVersionsListResponse`, `ArticleVersionSnapshotView`).
- Produces: `saveArticleDraft`, `discardArticleDraft`, `fetchArticleVersions`,
  `fetchArticleVersion`, `restoreArticleVersion`, `removeArticleAttachment`.

- [ ] **Step 1: Add the functions**

Add to `frontend/src/surfaces/agent-console/api/agentApi.ts`, right after the existing
`finalizeArticleAttachment` (and update its import line at the top to add
`ArticleVersionSnapshotView`, `ArticleVersionsListResponse`):

```typescript
export function saveArticleDraft(
  token: string,
  articleId: string,
  patch: { title?: string; body?: string; keywords?: string[] },
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/draft`, token, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function discardArticleDraft(token: string, articleId: string): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/draft`, token, { method: 'DELETE' });
}

export function fetchArticleVersions(
  token: string,
  articleId: string,
  opts: { limit?: number; cursor?: number } = {},
): Promise<ArticleVersionsListResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', String(opts.cursor));
  const query = params.toString();
  return call(`/agent/articles/${articleId}/versions${query ? `?${query}` : ''}`, token);
}

export function fetchArticleVersion(
  token: string,
  articleId: string,
  version: number,
): Promise<ArticleVersionSnapshotView> {
  return call(`/agent/articles/${articleId}/versions/${version}`, token);
}

export function restoreArticleVersion(
  token: string,
  articleId: string,
  version: number,
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/versions/${version}/restore`, token, { method: 'POST' });
}

export function removeArticleAttachment(
  token: string,
  articleId: string,
  attachmentId: string,
): Promise<AgentArticleDetail> {
  return call(`/agent/articles/${articleId}/attachments/${attachmentId}`, token, {
    method: 'DELETE',
  });
}
```

Also update the existing `finalizeArticleAttachment` to pass through an optional
`draft` flag:

```typescript
export function finalizeArticleAttachment(
  token: string,
  articleId: string,
  input: { key: string; filename: string; mimeType: string; byteSize: number; draft?: boolean },
): Promise<ArticleAttachmentView> {
  return call(`/agent/articles/${articleId}/attachments`, token, {
    method: 'POST',
    body: JSON.stringify({
      key: input.key,
      filename: input.filename,
      mime_type: input.mimeType,
      byte_size: input.byteSize,
      draft: input.draft,
    }),
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter <frontend-package-name> typecheck` (check `frontend/package.json`
for the exact workspace name — likely `pnpm --filter web typecheck` or similar; if
unsure, run the root `pnpm typecheck`).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Add frontend API client functions for article versioning"
```

---

### Task 9: Frontend — `ArticleEditorSheet`: draft banner, live-version badge, discard action

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts`

**Interfaces:**
- Consumes: `saveArticleDraft`, `discardArticleDraft` from Task 8;
  `AgentArticleDetail.draft`/`version` from Task 2.
- Produces: no new exports — this is UI wiring, verified by manual browser check in
  Step 4 (this component has no existing unit test file, per repo convention of
  testing this feature at the API-integration level, and `run` skill's "test the
  golden path in a browser" guidance applies here since it's a UI change).

- [ ] **Step 1: Retarget autosave for published articles**

In `useArticleAutosave.ts`, the `persist` function currently always calls
`createArticle`/`updateArticle`. Add a `mode` param so a published article's edits go
to the draft endpoint instead:

```typescript
export function useArticleAutosave(params: {
  token: string;
  articleId: string | null;
  mode: 'article' | 'draft';
  onCreated: (id: string) => void;
  onSaved?: (article: AgentArticleDetail) => void;
  fields: Fields;
}): {
  status: AutosaveStatus;
  ensureArticleId: () => Promise<string>;
  flush: () => Promise<void>;
} {
  const { token, mode, onCreated, onSaved } = params;
  // ... existing refs unchanged ...

  async function persist(fields: Fields): Promise<void> {
    setStatus('saving');
    const body = {
      title: fields.title,
      body: fields.body,
      keywords: fields.keywords,
      intent_id: fields.intentId ?? null,
    };
    if (articleIdRef.current === null) {
      const created: AgentArticleDetail = await createArticle(token, {
        title: body.title,
        body: body.body,
        keywords: body.keywords,
        intent_id: body.intent_id ?? undefined,
      });
      articleIdRef.current = created.id;
      onCreated(created.id);
      onSaved?.(created);
    } else if (mode === 'draft') {
      const updated = await saveArticleDraft(token, articleIdRef.current, {
        title: body.title,
        body: body.body,
        keywords: body.keywords,
      });
      onSaved?.(updated);
    } else {
      const updated = await updateArticle(token, articleIdRef.current, body);
      onSaved?.(updated);
    }
    setStatus('saved');
  }
  // ... rest unchanged ...
}
```

Add the `saveArticleDraft` import to the top of `useArticleAutosave.ts`:

```typescript
import { createArticle, saveArticleDraft, updateArticle } from '../../../api/agentApi.ts';
```

- [ ] **Step 2: Update `articleForm.ts` helpers**

`canEditFields` currently returns `state === 'draft'` only — a published article with
a draft overlay must also be editable (edits go to the draft, not the live row). Change
its signature to take draft-existence into account, and add a helper for the publish
button's new "has anything to publish" check:

```typescript
export function canEditFields(state: ArticleStateValue): boolean {
  return state === 'draft' || state === 'published';
}

export function canPublish(
  state: ArticleStateValue,
  title: string,
  body: string,
): boolean {
  // A draft-state article publishes its own title/body directly (first-ever
  // publish). A published article's Publish button always targets its draft
  // overlay, so the same non-empty check applies to whatever text is currently
  // shown in the editor (draft content when a draft exists, live content
  // otherwise — the caller passes the right one in).
  return (state === 'draft' || state === 'published') && title.trim() !== '' && body.trim() !== '';
}
```

(`archived` articles remain non-editable — neither branch matches `'archived'`.)

- [ ] **Step 3: Update `ArticleEditorSheet.tsx`**

Key changes to `ArticleEditorForm` (the inner component):

1. Track whether we're editing the draft overlay of a published article:

```typescript
const hasLiveContent = article !== null && article.state === 'published';
const draftView = article?.draft ?? null;
const editingMode: 'article' | 'draft' = hasLiveContent ? 'draft' : 'article';
```

2. Seed the form from the draft when one exists, otherwise from live content — change
   `draftFrom`:

```typescript
function draftFrom(article: AgentArticleDetail | null): Draft {
  if (!article) return { title: '', body: '', keywordsInput: '', intentId: '' };
  const source = article.draft ?? article;
  return {
    title: source.title,
    body: source.body,
    keywordsInput: source.keywords.join(', '),
    intentId: article.intent_id ?? '',
  };
}
```

(`intentId` deliberately always comes from the live `article`, never the draft — this
plan's scope keeps category/intent out of the draft overlay per the design doc's
non-goals: only `title`/`body`/`keywords`/attachments are versioned.)

3. Pass `mode: editingMode` to `useArticleAutosave(...)`.

4. Add the draft banner and live-version badge in the JSX, right after the
   `{!editable && ...}` block:

```tsx
{hasLiveContent && (
  <div className="flex items-center justify-between rounded-md bg-slate-100 px-3 py-2 text-xs">
    <span className="font-medium">Live: v{article!.version}</span>
    {draftView && (
      <span className="text-muted">
        Draft in progress · saved {new Date(draftView.updated_at).toLocaleTimeString()}
      </span>
    )}
  </div>
)}
```

5. Add a `discardDraft` mutation next to the existing `publish`/`archive` mutations:

```typescript
const discardDraft = useMutation({
  mutationFn: () => discardArticleDraft(token, resolvedArticleId!),
  onSuccess: (updated) => {
    queryClient.setQueryData<AgentArticleDetail>(['admin-article', updated.id], updated);
    invalidateArticles();
  },
});
```

Import `discardArticleDraft` alongside the other `agentApi.ts` imports.

6. In the footer, add a "Discard draft" button next to Publish/Archive, shown only
   when `draftView` exists:

```tsx
{canPublishOrArchive && draftView && (
  <Button
    type="button"
    variant="outline"
    onClick={() => discardDraft.mutate()}
    disabled={discardDraft.isPending}
  >
    Discard draft
  </Button>
)}
```

7. The `editable` flag computed earlier (`const editable = articleId === null ||
   canEditFields(state);`) now correctly returns `true` for `published` too, per Step
   2's change — no further edit needed there, but double check the banner text at the
   top ("This article is {state} and can no longer be edited") only shows for
   `archived`:

```tsx
{state === 'archived' && (
  <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-900">
    This article is archived and can no longer be edited.
  </p>
)}
```

- [ ] **Step 4: Manual browser verification**

Use the `run` skill to start the app locally. In the agent console's Knowledge Base
page:
1. Create a new article, publish it. Confirm the "Live: v1" badge appears and there's
   no "Draft in progress" text.
2. Edit the title. Confirm "Draft in progress" appears, the badge still says "v1", and
   the live article (check via a second tab on the public-facing surface, or `GET
   /surface/articles/:id`) still shows the old title.
3. Click Publish. Confirm the badge updates to "v2" and the draft banner disappears.
4. Edit again, then click "Discard draft". Confirm the banner disappears and the form
   reverts to the v2 content.
5. Confirm archived articles still show as non-editable.

Report any visual/UX issue found and fix before moving on — this is the point where a
type-correct but confusing UI would surface.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx \
  frontend/src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.ts \
  frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts
git commit -m "Add draft banner, live-version badge, discard action to article editor"
```

---

### Task 10: Frontend — version history tab and article list badges

**Files:**
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleVersionHistoryTab.tsx`
- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/lib/diffArticleVersion.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx`
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleTable.tsx`

**Interfaces:**
- Consumes: `fetchArticleVersions`/`fetchArticleVersion`/`restoreArticleVersion` (Task
  8); `ArticleVersionSummaryView`/`ArticleVersionSnapshotView` (Task 2).
- Produces: `ArticleVersionHistoryTab` component (props: `token: string, articleId:
  string, onRestored: () => void`); `diffArticleKeywords`, `diffArticleAttachments`
  helper functions other code doesn't need to know about internally, but are exported
  for potential reuse/testing.

- [ ] **Step 1: Write `diffArticleVersion.ts`**

Text diffing for `title`/`body` can reuse the same word-level approach as
`diffPromptText` in `frontend/src/surfaces/agent-console/pages/BotConfig/lib/
diffBotConfigVersion.ts` — check that file's `diffPromptText` implementation and import
it directly rather than reimplementing (it's a generic string-diff, not
bot-config-specific, so it's safe to reuse across features). Only `keywords` and
`attachments` need article-specific diff logic:

```typescript
import type { ArticleAttachmentView } from '@support/types';

export type FieldDiffEntry = { key: string; description: string };

export function diffKeywords(before: string[], after: string[]): FieldDiffEntry[] {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((k) => !beforeSet.has(k));
  const removed = before.filter((k) => !afterSet.has(k));
  const entries: FieldDiffEntry[] = [];
  if (added.length) entries.push({ key: 'keywords-added', description: `Added: ${added.join(', ')}` });
  if (removed.length)
    entries.push({ key: 'keywords-removed', description: `Removed: ${removed.join(', ')}` });
  return entries;
}

export function diffAttachments(
  before: ArticleAttachmentView[],
  after: ArticleAttachmentView[],
): FieldDiffEntry[] {
  const beforeIds = new Set(before.map((a) => a.id));
  const afterIds = new Set(after.map((a) => a.id));
  const entries: FieldDiffEntry[] = [];
  for (const a of after) {
    if (!beforeIds.has(a.id)) entries.push({ key: `att-add-${a.id}`, description: `Added "${a.filename}"` });
  }
  for (const a of before) {
    if (!afterIds.has(a.id))
      entries.push({ key: `att-remove-${a.id}`, description: `Removed "${a.filename}"` });
  }
  return entries;
}
```

If `diffPromptText` in the bot-config lib turns out to be named/shaped differently
than assumed here, read that file first and adapt the import — do not block on this
detail matching exactly; the important part is not re-implementing word-level text
diffing from scratch.

- [ ] **Step 2: Write `ArticleVersionHistoryTab.tsx`**

Model directly on `frontend/src/surfaces/agent-console/pages/BotConfig/components/
VersionHistoryTab.tsx` (read it in full first — Task planning already has its complete
source). Key differences from that component:
- Query keys are `['article-versions', articleId]` / `['article-version', articleId,
  version]`, not `['bot-config-versions']`.
- Restore does not invalidate `['bot-config']` — it invalidates `['admin-article',
  articleId]` (so the editor sheet's draft banner picks up the newly-populated draft)
  and calls the passed-in `onRestored` callback, which the sheet uses to switch back to
  its main edit view (see Step 3).
- The confirm dialog copy differs: "Restore this version?" / "This loads it into your
  draft for review — nothing goes live until you publish." (matching this feature's
  restore-into-draft behavior, not bot_config's immediate-rollback behavior).
- The current-version row shows "Current" and its button is disabled, same as
  bot_config — compute `currentVersion` from `versions[0]?.version` exactly as that
  component does.
- Diff rendering: `title`/`body` via the reused `diffPromptText`, `keywords` via
  `diffKeywords`, `attachments` via `diffAttachments` (both from Step 1).

```typescript
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ArticleVersionedField } from '@support/types';
import {
  fetchArticleVersion,
  fetchArticleVersions,
  restoreArticleVersion,
} from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import { ScrollArea } from '../../../components/ui/scroll-area.tsx';
import { ConfirmDialog } from '../../../components/ConfirmDialog.tsx';
import { diffPromptText } from '../../BotConfig/lib/diffBotConfigVersion.ts';
import { diffAttachments, diffKeywords } from '../lib/diffArticleVersion.ts';

const FIELD_LABELS: Record<ArticleVersionedField, string> = {
  title: 'Title',
  body: 'Body',
  keywords: 'Keywords',
  attachments: 'Attachments',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

function VersionDiff({
  token,
  articleId,
  version,
}: {
  token: string;
  articleId: string;
  version: number;
}) {
  const currentQuery = useQuery({
    queryKey: ['article-version', articleId, version],
    queryFn: () => fetchArticleVersion(token, articleId, version),
  });
  const priorQuery = useQuery({
    queryKey: ['article-version', articleId, version - 1],
    queryFn: () => fetchArticleVersion(token, articleId, version - 1),
    enabled: version > 1,
  });

  if (currentQuery.isLoading || (version > 1 && priorQuery.isLoading)) {
    return <p className="text-xs text-muted">Loading diff…</p>;
  }
  if (version === 1 || !priorQuery.data) {
    return <p className="text-xs text-muted">No prior changes.</p>;
  }
  const current = currentQuery.data;
  const prior = priorQuery.data;
  if (!current) return null;

  const titleTokens = current.title !== prior.title ? diffPromptText(prior.title, current.title) : null;
  const bodyTokens = current.body !== prior.body ? diffPromptText(prior.body, current.body) : null;
  const keywordEntries = diffKeywords(prior.keywords, current.keywords);
  const attachmentEntries = diffAttachments(prior.attachments, current.attachments);

  return (
    <div className="flex flex-col gap-2 text-xs">
      {titleTokens && (
        <div>
          <p className="font-medium">Title</p>
          <p className="rounded bg-slate-50 p-2 font-mono">
            {titleTokens.map((token, i) => (
              <span
                key={i}
                className={
                  token.type === 'added'
                    ? 'bg-green-100 text-green-800'
                    : token.type === 'removed'
                      ? 'bg-red-100 text-red-800 line-through'
                      : undefined
                }
              >
                {token.text}{' '}
              </span>
            ))}
          </p>
        </div>
      )}
      {bodyTokens && (
        <div>
          <p className="font-medium">Body</p>
          <p className="rounded bg-slate-50 p-2 font-mono">
            {bodyTokens.map((token, i) => (
              <span
                key={i}
                className={
                  token.type === 'added'
                    ? 'bg-green-100 text-green-800'
                    : token.type === 'removed'
                      ? 'bg-red-100 text-red-800 line-through'
                      : undefined
                }
              >
                {token.text}{' '}
              </span>
            ))}
          </p>
        </div>
      )}
      {[...keywordEntries, ...attachmentEntries].map((entry) => (
        <p key={entry.key}>{entry.description}</p>
      ))}
    </div>
  );
}

export function ArticleVersionHistoryTab({
  token,
  articleId,
  onRestored,
}: {
  token: string;
  articleId: string;
  onRestored: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<number | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['article-versions', articleId],
    queryFn: () => fetchArticleVersions(token, articleId, { limit: 50 }),
  });

  const restore = useMutation({
    mutationFn: (version: number) => restoreArticleVersion(token, articleId, version),
    onSuccess: (updated) => {
      setRestoreTarget(null);
      queryClient.setQueryData(['admin-article', articleId], updated);
      void queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
      onRestored();
    },
  });

  const versions = versionsQuery.data?.versions ?? [];
  const currentVersion = versions[0]?.version ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <ScrollArea className="min-h-0 flex-1">
        <ul className="flex flex-col gap-2">
          {versions.map((entry) => (
            <li key={entry.version} className="rounded-md border border-slate-200 p-2 text-xs">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 text-left"
                onClick={() => setExpanded((v) => (v === entry.version ? null : entry.version))}
              >
                <span className="flex items-center gap-2">
                  <span className="font-semibold">
                    v{entry.version}
                    {entry.version === currentVersion ? ' · Current' : ''}
                  </span>
                  <span className="text-muted">{entry.actor.display_name}</span>
                  <span className="text-muted">{relativeTime(entry.created_at)}</span>
                </span>
                <span className="flex gap-1">
                  {entry.changed_fields.map((field) => (
                    <span key={field} className="rounded bg-slate-100 px-1.5 py-0.5">
                      {FIELD_LABELS[field]}
                    </span>
                  ))}
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => setRestoreTarget(entry.version)}
                disabled={restore.isPending || entry.version === currentVersion}
              >
                {entry.version === currentVersion ? 'Current version' : 'Restore this version'}
              </Button>
              {expanded === entry.version && (
                <div className="mt-2 border-t border-slate-100 pt-2">
                  <VersionDiff token={token} articleId={articleId} version={entry.version} />
                </div>
              )}
            </li>
          ))}
          {versions.length === 0 && <li className="text-xs text-muted">No changes yet.</li>}
        </ul>
      </ScrollArea>
      {restore.isError && <p className="text-xs text-red-600">{restore.error?.message}</p>}
      <ConfirmDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
        title="Restore this version?"
        description="This loads it into your draft for review — nothing goes live until you publish."
        confirmLabel="Restore"
        confirming={restore.isPending}
        onConfirm={() => restoreTarget !== null && restore.mutate(restoreTarget)}
      />
    </div>
  );
}
```

- [ ] **Step 3: Wire the tab into `ArticleEditorSheet.tsx`**

The sheet currently renders a single form, no tabs. Add a `Tabs` wrapper (same
`components/ui/tabs.tsx` `BotConfig.tsx` uses) around the existing form content when
editing a published article, with an "Edit" tab (today's form) and a "History" tab:

```tsx
{hasLiveContent ? (
  <Tabs defaultValue="edit" className="flex min-h-0 flex-1 flex-col gap-0">
    <TabsList className="mx-4 mt-2 w-fit">
      <TabsTrigger value="edit">Edit</TabsTrigger>
      <TabsTrigger value="history">History</TabsTrigger>
    </TabsList>
    <TabsContent value="edit" className="flex min-h-0 flex-1 flex-col gap-0" forceMount>
      {/* existing form JSX (the big <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"> block) unchanged */}
    </TabsContent>
    <TabsContent value="history" className="min-h-0 flex-1 overflow-auto p-4">
      <ArticleVersionHistoryTab
        token={token}
        articleId={resolvedArticleId!}
        onRestored={() => setActiveTab('edit')}
      />
    </TabsContent>
  </Tabs>
) : (
  /* existing form JSX, unwrapped, for draft-state / new articles */
)}
```

This needs a controlled `activeTab` state (`useState<'edit' | 'history'>('edit')`) so
`onRestored` can switch back to Edit — check `components/ui/tabs.tsx`'s API (it's the
shadcn/ui `Tabs` primitive; if it only supports `defaultValue` uncontrolled, switch to
`value={activeTab} onValueChange={setActiveTab}` instead of `defaultValue`). The footer
(`SheetFooter` with Publish/Archive/Discard draft) stays outside both tabs, always
visible, since those actions apply regardless of which tab is showing.

- [ ] **Step 4: Add version badge and draft indicator to `ArticleTable.tsx`**

```tsx
<TableCell>
  <div className="flex items-center gap-1">
    <Badge variant={STATE_BADGE_VARIANT[a.state]}>{a.state}</Badge>
    {a.state === 'published' && <span className="text-xs text-muted">v{a.version}</span>}
    {a.has_draft && (
      <span
        className="h-1.5 w-1.5 rounded-full bg-amber-500"
        title="Draft in progress"
      />
    )}
  </div>
</TableCell>
```

This requires `AgentArticlesResponse`'s rows to carry `version`/`has_draft` — go back
to `listArticles` in `articlesService.ts` (Task 3 touched `toDetail`, not this) and add
both fields to its mapped row:

```typescript
export async function listArticles(ctx: AgentContext): Promise<AgentArticlesResponse> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const rows = await tx.select().from(article).orderBy(desc(article.createdAt));
    const draftArticleIds = new Set(
      (
        await tx
          .select({ articleId: articleVersion.articleId })
          .from(articleVersion)
          .where(eq(articleVersion.status, 'draft'))
      ).map((r) => r.articleId),
    );
    return {
      articles: rows.map((r) => ({
        id: r.id,
        title: r.title,
        body: r.body,
        state: r.state,
        version: r.version,
        has_draft: draftArticleIds.has(r.id),
        intent_id: r.intentId,
        created_at: r.createdAt.toISOString(),
        published_at: r.publishedAt ? r.publishedAt.toISOString() : null,
      })),
    };
  });
}
```

(This queries `article_version` once for the whole workspace's draft set rather than
per-row, avoiding an N+1.)

- [ ] **Step 5: Manual browser verification**

Using the same running app from Task 9:
1. Publish an article, edit it (creating a draft), go back to the list — confirm the
   amber dot appears next to its row and the version still reads "v1" (not yet bumped).
2. Open the article, switch to the History tab — confirm v1 is listed as "Current"
   with no diff (empty state), since only one version exists.
3. Publish the pending edit, reopen History — confirm v2 now appears above v1, v1 is
   no longer "Current", and expanding v2 shows a real diff against v1.
4. Click "Restore this version" on v1 — confirm it switches back to the Edit tab with
   v1's content loaded as the draft, and the live content is still v2 until Publish is
   clicked again.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleVersionHistoryTab.tsx \
  frontend/src/surfaces/agent-console/pages/KnowledgeBase/lib/diffArticleVersion.ts \
  frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx \
  frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleTable.tsx \
  backend/src/agent/services/articlesService.ts
git commit -m "Add article version history tab, list badges, and draft indicator"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `pnpm --filter @support/api test`
Expected: all PASS, including `rls.test.ts` (confirm the new `article_version` RLS
policy from Task 1 doesn't break workspace isolation for any other table) and
`surface.articles.test.ts` (confirm the public/player-facing article routes are
completely unaffected — they never read `article_version`).

- [ ] **Step 2: Run typecheck across the whole workspace**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run `pnpm lint`**

Run: `pnpm lint`
Expected: PASS, or only pre-existing warnings unrelated to these files.

- [ ] **Step 4: Confirm `pnpm db:setup` is still idempotent**

Run: `pnpm db:setup` a second time (no schema changes since the last run in Task 1).
Expected: completes without error — confirms the hand-written trigger/backfill
migrations are safe to re-run (the trigger `CREATE TRIGGER` is not `CREATE OR REPLACE
TRIGGER`; if this errors on a second run, wrap it in a `DROP TRIGGER IF EXISTS
article_version_append_only ON article_version;` before the `CREATE TRIGGER` line, and
re-test).

- [ ] **Step 5: Final commit if any fixes were needed in Steps 1–4**

If everything passed with no changes, there's nothing to commit — this task is a gate,
not necessarily a diff.
