> **SUPERSEDED by `docs/plans/2026-08-25-article-image-attachments-implementation.md`.** That plan
> covers the same feature plus autosave and uses a slightly different schema/handle scheme. Do not
> execute this file — kept for history only.

# Article Image Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the `article_attachment` table, add presigned-upload endpoints for article images, and replace the admin console's disabled "Attachments — coming soon" state with a working upload UI wired into the MDXEditor body and the player-facing article renderer.

**Architecture:** Reuses Phase 1's MinIO storage choke point (`backend/src/shared/storage/presign.ts`) and its generic pending-upload endpoints (`POST /agent/uploads`, `DELETE /agent/uploads/:key`) unchanged — no article-specific presign route is added. A new `POST /agent/articles/:id/attachments` claims a pending upload the same way Phase 1's `sendAgentMessage` claims one for chat: HEAD-verify → CopyObject to a permanent key → insert an `article_attachment` row, all in one transaction. Like the `message` attachment table, **no `article_attachment` row exists until claim** — this diverges from the original schema-only doc's implied "row exists with a null `storage_key` pre-upload" and instead follows the convention Phase 1 established as the repo's actual attachment pattern. The `status` column stays (still defaults `'pending'` at the schema level for any other caller), but every row this plan inserts is written already `'claimed'`.

Image *placement* in a body uses a custom URI scheme, `attachment://{attachmentId}`, inserted into the markdown by the editor's own upload handler — never a resolved URL, so the body text stays valid forever even as signed URLs rotate. Both `AgentArticleDetail` and `PublicArticleDetail` gain an `attachments: ArticleAttachmentView[]` array (id, filename, mime_type, byte_size, and a fresh-signed `url`, signed at the same place and time the article row itself is serialized — matching Phase 1's "signed fresh per read" rule). The frontend resolves `attachment://{id}` handles against that array at render time: this is exactly the seam `ArticleBody.tsx`'s existing `ArticleImage` component and code comment already describe ("this component learns to recognise an attachment handle and resolve it to a signed URL, and nothing else in the app changes").

**Tech Stack:** Drizzle ORM, Express 5, Zod, `@aws-sdk/client-s3` (via the existing storage choke point), React, `@mdxeditor/editor`, TanStack Query.

**Spec:** `docs/specs/2026-08-06-articles-knowledge-base-design.md`, `docs/specs/2026-08-17-article-markdown-rendering-design.md`, `docs/specs/2026-08-24-minio-attachments-agent-chat-design.md` §"Relationship to `article_attachment`" (this phase closes that gap).

## Global Constraints

- Images only: `image/png`, `image/jpeg`, `image/webp`, `image/gif` — reuse `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` from `backend/src/shared/storage/presign.ts`, do not redeclare them.
- Attachments may only be claimed onto an article in `draft` state — matches the existing `updateArticle` draft-only rule.
- No hard deletes: there is no `DELETE` route for a claimed `article_attachment` row. An attachment never referenced by the body is harmless clutter, same trade-off already accepted for pending-but-unsent chat uploads.
- Object keys are server-generated UUIDs. Claimed key layout: `ws/{workspaceId}/attachments/{uuid}.{ext}` — identical prefix Phase 1 uses for message attachments; both share one bucket, collisions are structurally impossible since keys are UUIDs.
- All new/changed routes are registered in `backend/src/docs/openapi.ts`.
- Follow existing repo conventions exactly: RLS is structural (`workspace_id` column + `db:setup`, no manual policy), `404` not `403` for "not yours", `sendError(res, status, code, message)`, `logger` never `console.*`.

---

### Task 1: Add `mime_type`/`byte_size` to `article_attachment` and drop the pre-claim row shape

**Files:**
- Modify: `backend/src/shared/db/schema/articles.ts`
- Modify: `backend/tests/helpers/db.ts`
- Test: `backend/tests/domain.articleAttachment.test.ts` (new)

**Interfaces:**
- Produces: `articleAttachment` Drizzle table (re-exported from `backend/src/shared/db/schema/index.ts` via its existing `export * from './articles.ts'`), columns `id, workspaceId, articleId, filename, storageKey, mimeType, byteSize, status, createdAt`.

- [ ] **Step 1: Add the columns**

In `backend/src/shared/db/schema/articles.ts`, change the import line and the table:

```ts
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
```

```ts
/**
 * No row exists until claim — same convention as `attachment` (conversations.ts).
 * `status` stays for schema continuity but every row this app inserts is
 * already 'claimed'; nothing here transitions a row from 'pending' to
 * 'claimed' in place.
 */
export const articleAttachment = pgTable('article_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  articleId: uuid('article_id')
    .notNull()
    .references(() => article.id, { onDelete: 'restrict' }),
  filename: text('filename').notNull(),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
```

(`storageKey` changes from nullable to `.notNull()` — safe because no row exists in any environment yet; the table has been schema-only since it was created.)

- [ ] **Step 2: Generate and apply the migration**

```bash
cd backend && pnpm db:generate
pnpm db:setup
```

Expected: a new file under `backend/drizzle/` with `ALTER TABLE "article_attachment" ADD COLUMN "mime_type" text NOT NULL, ADD COLUMN "byte_size" integer NOT NULL` and `ALTER COLUMN "storage_key" SET NOT NULL`. `db:setup` exits 0.

- [ ] **Step 3: Add `article_attachment` to the test-truncation table list**

In `backend/tests/helpers/db.ts`, add `'article_attachment'` to `SCOPED_TABLES`, positioned before `'article'` (dependent listed before parent, matching the file's existing convention):

```ts
const SCOPED_TABLES = [
  'article_attachment',
  'article',
  // ...unchanged rest
```

- [ ] **Step 4: Write a failing test proving the new constraints**

`backend/tests/domain.articleAttachment.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';
import { beforeEach } from 'vitest';

beforeEach(truncateAll);

describe('article_attachment table', () => {
  it('rejects a row with no matching article', async () => {
    const workspaceId = await seedWorkspace();
    await expect(
      ownerPool.query(
        `insert into article_attachment
           (workspace_id, article_id, filename, storage_key, mime_type, byte_size)
         values ($1, $2, 'shot.png', 'ws/x/attachments/y.png', 'image/png', 10)`,
        [workspaceId, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('rejects a row with a null storage_key', async () => {
    const workspaceId = await seedWorkspace();
    const { rows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a@example.test', 'A') returning id`,
    );
    const { rows: articleRows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, 't', 'b', $2) returning id`,
      [workspaceId, rows[0]!.id],
    );
    await expect(
      ownerPool.query(
        `insert into article_attachment
           (workspace_id, article_id, filename, mime_type, byte_size)
         values ($1, $2, 'shot.png', 'image/png', 10)`,
        [workspaceId, articleRows[0]!.id],
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd backend && pnpm test tests/domain.articleAttachment.test.ts`
Expected: PASS — both constraints are enforced by the migration from Step 2, not by new application code; this test verifies the migration actually applied.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/db/schema/articles.ts backend/drizzle backend/tests/helpers/db.ts backend/tests/domain.articleAttachment.test.ts
git commit -m "Complete article_attachment schema: mime_type, byte_size, required storage_key"
```

---

### Task 2: Claim endpoint — `POST /agent/articles/:id/attachments`

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Modify: `backend/src/agent/controllers/articlesController.ts`
- Modify: `backend/src/agent/routers/articlesRouter.ts`
- Modify: `packages/types/src/articles.ts`
- Test: `backend/tests/agent.articles.test.ts` (extend)

**Interfaces:**
- Consumes: `headObject`, `copyObject`, `ALLOWED_IMAGE_MIME_TYPES`, `MAX_ATTACHMENT_BYTES` from `backend/src/shared/storage/presign.ts`; `deleteObject` from the same module; `articleAttachment` table from Task 1.
- Produces (used by Task 3 and the frontend Task 5):
  - `ClaimArticleAttachmentBody = z.object({ key: z.string().min(1), filename: z.string().min(1).max(255), content_type: z.string().min(1), byte_size: z.number().int().positive() })` — `packages/types/src/articles.ts`
  - `ArticleAttachmentView = { id: string; filename: string; mime_type: string; byte_size: number; url: string | null }` — same file, added to both `AgentArticleDetail` and `PublicArticleDetail` as `attachments: ArticleAttachmentView[]`
  - `claimArticleAttachment(ctx: AgentContext, articleId: string, body): Promise<ClaimArticleAttachmentResult>` — `articlesService.ts`, result union `{ ok: true; attachment: ArticleAttachmentView } | { ok: false; reason: 'not_found' | 'not_draft' | 'attachment_not_found' | 'attachment_mismatch' }`

- [ ] **Step 1: Add the wire types**

In `packages/types/src/articles.ts`, add:

```ts
export const ClaimArticleAttachmentBody = z.object({
  key: z.string().min(1),
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
});

export type ArticleAttachmentView = {
  id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  url: string | null;
};
```

Extend `AgentArticleDetail` and `PublicArticleDetail`, each gaining:

```ts
  attachments: ArticleAttachmentView[];
```

- [ ] **Step 2: Write the failing test**

Add to `backend/tests/agent.articles.test.ts` (it already has `seedAgent`/`app` set up for `articlesRouter`; add the import for `presignPutObject` and a fixture helper alongside the existing tests):

```ts
import { presignPutObject } from '../src/shared/storage/presign.ts';

async function uploadFixtureImage(workspaceId: string, agentId: string) {
  const key = `pending/${workspaceId}/${agentId}/${randomUUID()}.png`;
  const body = Buffer.from('fake-png-bytes');
  const { url } = await presignPutObject({ key, contentType: 'image/png', contentLength: body.length });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
    body,
  });
  return key;
}

describe('POST /agent/articles/:id/attachments', () => {
  it('claims a pending upload onto a draft article', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key, filename: 'diagram.png', content_type: 'image/png', byte_size: 14 })
      .expect(200);

    expect(res.body.attachment).toMatchObject({ filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 });

    const { rows } = await ownerPool.query(
      `select storage_key from article_attachment where article_id = $1`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_key).toContain(`ws/${workspaceId}/attachments/`);
  });

  it('409s when the article is not a draft', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const key = await uploadFixtureImage(workspaceId, agentId);

    await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key, filename: 'diagram.png', content_type: 'image/png', byte_size: 14 })
      .expect(409);
  });

  it('422s with attachment_not_found for a bogus key', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        key: `pending/${workspaceId}/nobody/${randomUUID()}.png`,
        filename: 'ghost.png',
        content_type: 'image/png',
        byte_size: 14,
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });
});
```

(Add `import { randomUUID } from 'node:crypto';` at the top of the file if not already present.)

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: FAIL — `404` from the router (no such route yet).

- [ ] **Step 4: Implement the service function**

In `backend/src/agent/services/articlesService.ts`, add imports and the function:

```ts
import { randomUUID } from 'node:crypto';
import type { ArticleAttachmentView, ClaimArticleAttachmentBody } from '@support/types';
import type { z } from 'zod';
import { articleAttachment } from '../../shared/db/schema/index.ts';
import { copyObject, headObject } from '../../shared/storage/presign.ts';
```

```ts
export type ClaimArticleAttachmentResult =
  | { ok: true; attachment: ArticleAttachmentView }
  | { ok: false; reason: 'not_found' | 'not_draft' | 'attachment_not_found' | 'attachment_mismatch' };

export async function claimArticleAttachment(
  ctx: AgentContext,
  articleId: string,
  body: z.infer<typeof ClaimArticleAttachmentBody>,
): Promise<ClaimArticleAttachmentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };

    const real = await headObject(body.key);
    if (!real) return { ok: false, reason: 'attachment_not_found' };
    if (real.contentType !== body.content_type || real.contentLength !== body.byte_size) {
      return { ok: false, reason: 'attachment_mismatch' };
    }

    const extension = body.key.slice(body.key.lastIndexOf('.'));
    const destKey = `ws/${ctx.workspaceId}/attachments/${randomUUID()}${extension}`;
    await copyObject({ sourceKey: body.key, destKey });

    const [row] = await tx
      .insert(articleAttachment)
      .values({
        workspaceId: ctx.workspaceId,
        articleId,
        filename: body.filename,
        storageKey: destKey,
        mimeType: body.content_type,
        byteSize: body.byte_size,
        status: 'claimed',
      })
      .returning();

    return {
      ok: true,
      attachment: {
        id: row!.id,
        filename: row!.filename,
        mime_type: row!.mimeType,
        byte_size: row!.byteSize,
        url: null,
      },
    };
  });
}
```

Note: unlike Phase 1's chat claim, the pending object is **not** deleted here — deletion happens outside the transaction in the controller, after a successful claim, using the same best-effort-after-commit pattern Phase 1 established (`deleteObject` is idempotent and safe to call even if this handler is retried).

- [ ] **Step 5: Implement the controller and route**

In `backend/src/agent/controllers/articlesController.ts`, add:

```ts
import { ClaimArticleAttachmentBody } from '@support/types';
import { claimArticleAttachment } from '../services/articlesService.ts';
import { deleteObject } from '../../shared/storage/presign.ts';

export const claimArticleAttachmentHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const body = ClaimArticleAttachmentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'key, filename, content_type and byte_size are required.');
    return;
  }
  const result = await claimArticleAttachment(req.agent!, params.data.id, body.data);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Article not found.');
      return;
    }
    if (result.reason === 'not_draft') {
      sendError(res, 409, 'invalid_request', 'Article is not a draft.');
      return;
    }
    if (result.reason === 'attachment_not_found') {
      sendError(res, 422, 'attachment_not_found', 'The uploaded file was not found or has expired.');
      return;
    }
    sendError(res, 422, 'attachment_mismatch', 'The uploaded file does not match its declared type or size.');
    return;
  }
  await deleteObject(body.data.key);
  res.status(200).json({ attachment: result.attachment });
};
```

In `backend/src/agent/routers/articlesRouter.ts`, add:

```ts
import { claimArticleAttachmentHandler } from '../controllers/articlesController.ts';
// ...
articlesRouter.post('/articles/:id/attachments', claimArticleAttachmentHandler);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: PASS (all prior tests plus the 3 new ones).

- [ ] **Step 7: Register the route in OpenAPI**

In `backend/src/docs/openapi.ts`, near the other `/agent/articles*` registrations, add:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/attachments',
  summary: 'Agent Claim Article Attachment',
  description: 'Claims a pending upload (from POST /agent/uploads) onto a draft article.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            key: z.string(),
            filename: z.string().min(1).max(255),
            content_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
            byte_size: z.number().int().positive(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Attachment claimed' },
    404: { description: 'Article not found' },
    409: { description: 'Article is not a draft' },
    422: { description: 'Upload not found, expired, or mismatched' },
  },
});
```

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/src/agent/controllers/articlesController.ts backend/src/agent/routers/articlesRouter.ts packages/types/src/articles.ts backend/tests/agent.articles.test.ts backend/src/docs/openapi.ts
git commit -m "Add article attachment claim endpoint"
```

---

### Task 3: Sign attachment URLs on article read (agent and public)

**Files:**
- Modify: `backend/src/agent/services/articlesService.ts`
- Modify: `backend/src/surface/services/articlesService.ts`
- Test: `backend/tests/agent.articles.test.ts` (extend), `backend/tests/surface.articles.test.ts` (extend)

**Interfaces:**
- Consumes: `presignGetObject` from `backend/src/shared/storage/presign.ts`; `articleAttachment` table.
- Produces: `getArticle` (agent) and the public article-detail service both return `attachments: ArticleAttachmentView[]` with a fresh-signed `url`.

- [ ] **Step 1: Write the failing agent-side test**

Add to `backend/tests/agent.articles.test.ts`:

```ts
describe('GET /agent/articles/:id with an attachment', () => {
  it('returns a fetchable presigned url for a claimed attachment', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Refund policy', body: 'See below.' })
      .expect(201);
    const key = await uploadFixtureImage(workspaceId, agentId);
    await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key, filename: 'diagram.png', content_type: 'image/png', byte_size: 14 })
      .expect(200);

    const res = await request(app)
      .get(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].url).toBeTruthy();
    const getRes = await fetch(res.body.attachments[0].url);
    expect(getRes.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: FAIL — `res.body.attachments` is `undefined`.

- [ ] **Step 3: Implement signing in the agent service**

In `backend/src/agent/services/articlesService.ts`, add the join and signing pass. Replace `getArticle`:

```ts
import { presignGetObject } from '../../shared/storage/presign.ts';

export async function getArticle(
  ctx: AgentContext,
  id: string,
): Promise<AgentArticleDetail | null> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [row] = await tx.select().from(article).where(eq(article.id, id)).limit(1);
    if (!row) return null;

    const attachmentRows = await tx
      .select()
      .from(articleAttachment)
      .where(eq(articleAttachment.articleId, id));

    const attachments = await Promise.all(
      attachmentRows.map(async (a) => {
        try {
          return {
            id: a.id,
            filename: a.filename,
            mime_type: a.mimeType,
            byte_size: a.byteSize,
            url: await presignGetObject(a.storageKey),
          };
        } catch {
          // A broken attachment must not break loading the rest of the article.
          return { id: a.id, filename: a.filename, mime_type: a.mimeType, byte_size: a.byteSize, url: null };
        }
      }),
    );

    return { ...toDetail(row), attachments };
  });
}
```

(`toDetail` stays unchanged — `attachments` is spread on afterward since it needs a second query the row-mapper doesn't have access to.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing public-surface test**

First inspect `backend/src/surface/services/articlesService.ts`'s `toDetail`/`getArticle`-equivalent (the function powering `GET /surface/articles/:id`) to match its existing shape before editing. Add to `backend/tests/surface.articles.test.ts`, reusing that file's `fixture()`/`seedArticle()` helpers plus a claim call through the *agent* router (import `agent.articles.test.ts`'s app is not reusable across files — instead seed the `article_attachment` row directly via `ownerPool.query`, uploading the real object first):

```ts
import { presignPutObject } from '../src/shared/storage/presign.ts';

describe('GET /surface/articles/:id with an attachment', () => {
  it('returns a fetchable presigned url for a published article', async () => {
    const { workspaceId, token } = await fixture();
    const articleId = await seedArticle(workspaceId, { state: 'published' });

    const key = `ws/${workspaceId}/attachments/${crypto.randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({ key, contentType: 'image/png', contentLength: body.length });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
      body,
    });
    await ownerPool.query(
      `insert into article_attachment (workspace_id, article_id, filename, storage_key, mime_type, byte_size, status)
       values ($1, $2, 'diagram.png', $3, 'image/png', $4, 'claimed')`,
      [workspaceId, articleId, key, body.length],
    );

    const res = await request(app).get(`/articles/${articleId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.attachments).toHaveLength(1);
    const getRes = await fetch(res.body.attachments[0].url);
    expect(getRes.status).toBe(200);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd backend && pnpm test tests/surface.articles.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement signing in the surface service**

Mirror Step 3's change in `backend/src/surface/services/articlesService.ts`'s article-detail function, importing `articleAttachment` from `../../shared/db/schema/index.ts` and `presignGetObject` the same way, appending `attachments` to `PublicArticleDetail` the same way `getArticle` (agent) does above.

- [ ] **Step 8: Run both test files to verify they pass**

Run: `cd backend && pnpm test tests/agent.articles.test.ts tests/surface.articles.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the OpenAPI response schemas**

In `backend/src/docs/openapi.ts`, extend both the `AgentArticleDetail`-equivalent and `PublicArticleDetail`-equivalent registered response schemas with:

```ts
  attachments: z.array(
    z.object({
      id: z.uuid(),
      filename: z.string(),
      mime_type: z.string(),
      byte_size: z.number().int().positive(),
      url: z.string().nullable(),
    }),
  ),
```

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/src/surface/services/articlesService.ts backend/tests/agent.articles.test.ts backend/tests/surface.articles.test.ts backend/src/docs/openapi.ts
git commit -m "Sign article attachment URLs on read, agent and public"
```

---

### Task 4: Frontend — `attachment://` resolution in `ArticleBody`

**Files:**
- Modify: `frontend/src/features/articles/components/ArticleBody.tsx`
- Modify: `frontend/src/surfaces/webview/pages/ArticleSheet.tsx` (or wherever `<ArticleBody markdown=.../>` is called — confirm with `grep -rn "<ArticleBody" frontend/src` before editing)
- Test: `frontend/src/features/articles/components/ArticleBody.test.tsx` (extend if it exists, else create alongside the component)

**Interfaces:**
- Consumes: `ArticleAttachmentView[]` from `@support/types` (Task 2).
- Produces: `ArticleBody` gains an `attachments?: ArticleAttachmentView[]` prop, default `[]`. No other prop changes.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArticleBody } from './ArticleBody.tsx';

describe('ArticleBody attachment resolution', () => {
  it('resolves an attachment:// handle to its signed url', () => {
    render(
      <ArticleBody
        markdown="![diagram](attachment://a1)"
        attachments={[{ id: 'a1', filename: 'diagram.png', mime_type: 'image/png', byte_size: 10, url: 'https://minio.local/signed' }]}
      />,
    );
    expect(screen.getByAltText('diagram')).toHaveAttribute('src', 'https://minio.local/signed');
  });

  it('falls back to alt text when the handle has no matching attachment', () => {
    render(<ArticleBody markdown="![diagram](attachment://missing)" attachments={[]} />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('diagram')).toBeInTheDocument();
  });

  it('still renders an ordinary external image url unchanged', () => {
    render(<ArticleBody markdown="![x](https://example.test/a.png)" attachments={[]} />);
    expect(screen.getByAltText('x')).toHaveAttribute('src', 'https://example.test/a.png');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm test src/features/articles/components/ArticleBody.test.tsx`
Expected: FAIL — `attachments` prop doesn't exist; the `attachment://` src is passed straight to `<img>` unresolved.

- [ ] **Step 3: Implement the resolution**

In `frontend/src/features/articles/components/ArticleBody.tsx`:

```tsx
import type { ArticleAttachmentView } from '@support/types';
```

Change `ArticleImage` and `getComponents` to accept the attachment list:

```tsx
function ArticleImage({
  src,
  alt,
  attachments,
}: {
  src?: string;
  alt?: string;
  attachments: ArticleAttachmentView[];
}) {
  const [failed, setFailed] = useState(false);

  const resolvedSrc = src?.startsWith('attachment://')
    ? (attachments.find((a) => a.id === src.slice('attachment://'.length))?.url ?? undefined)
    : src;

  if (failed || !resolvedSrc) {
    return alt ? <span className="mb-3 block text-sm text-muted italic">{alt}</span> : null;
  }

  return (
    <img
      src={resolvedSrc}
      alt={alt ?? ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className="mb-3 h-auto max-w-full rounded-card"
    />
  );
}
```

```tsx
function getComponents(dark: boolean, attachments: ArticleAttachmentView[]): Components {
  // ...unchanged local consts...
  return {
    // ...unchanged entries...
    img: ({ src, alt }) => (
      <ArticleImage src={typeof src === 'string' ? src : undefined} alt={alt} attachments={attachments} />
    ),
    // ...unchanged rest...
  };
}

export function ArticleBody({
  markdown,
  dark = false,
  attachments = [],
}: {
  markdown: string;
  dark?: boolean;
  attachments?: ArticleAttachmentView[];
}) {
  return (
    <div className={`text-base leading-relaxed ${dark ? 'text-accent-fg' : 'text-text'}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={getComponents(dark, attachments)}>
        {markdown}
      </Markdown>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm test src/features/articles/components/ArticleBody.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the call site**

Find every `<ArticleBody markdown=.../>` call:

```bash
grep -rn "<ArticleBody" frontend/src
```

For each, pass `attachments={article.data.attachments}` (using whatever the local variable holding the fetched `AgentArticleDetail`/`PublicArticleDetail` is actually named at that call site).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/articles/components/ArticleBody.tsx frontend/src/features/articles/components/ArticleBody.test.tsx
git commit -m "Resolve attachment:// image handles in ArticleBody"
```

(Commit the call-site file(s) touched in Step 5 alongside this, once identified.)

---

### Task 5: Frontend — admin console "Attachments" upload panel

**Files:**
- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx`
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Test: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx` (extend; if none exists, check `KnowledgeBase.test.tsx` for the existing coverage pattern first)

**Interfaces:**
- Consumes: `requestUpload`, `putFileToUploadUrl`, `cancelUpload` from `agentApi.ts` (already added by Phase 1's Task 6 for chat); `POST /agent/articles/:id/attachments` (Task 2).
- Produces: none consumed elsewhere — this is the UI's terminal task.

- [ ] **Step 1: Add the claim API function**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, add near the article functions:

```ts
export function claimArticleAttachment(
  token: string,
  articleId: string,
  input: { key: string; filename: string; contentType: string; byteSize: number },
): Promise<{ attachment: ArticleAttachmentView }> {
  return call(`/agent/articles/${articleId}/attachments`, token, {
    method: 'POST',
    body: JSON.stringify({
      key: input.key,
      filename: input.filename,
      content_type: input.contentType,
      byte_size: input.byteSize,
    }),
  });
}
```

Add `import type { ArticleAttachmentView } from '@support/types';` to the file's existing type-only import block.

- [ ] **Step 2: Write the failing test**

Check the existing test file for `ArticleEditorSheet` (or `KnowledgeBase.test.tsx`) for how it mocks `agentApi` and renders the sheet with a seeded draft article, then add:

```tsx
it('uploads an image and inserts an attachment:// reference into the body', async () => {
  vi.mocked(agentApi.requestUpload).mockResolvedValue({
    key: 'pending/ws/agent/uuid.png',
    upload_url: 'https://minio.local/put',
    expires_at: new Date().toISOString(),
  });
  vi.mocked(agentApi.putFileToUploadUrl).mockResolvedValue(undefined);
  vi.mocked(agentApi.claimArticleAttachment).mockResolvedValue({
    attachment: { id: 'a1', filename: 'diagram.png', mime_type: 'image/png', byte_size: 3, url: null },
  });

  // ...render the sheet with a draft article, matching this file's existing setup...

  const file = new File([new Uint8Array(3)], 'diagram.png', { type: 'image/png' });
  const input = screen.getByLabelText('Insert image'); // MDXEditor's InsertImage toolbar control
  fireEvent.change(input, { target: { files: [file] } });

  await screen.findByAltText('diagram.png');
  expect(agentApi.claimArticleAttachment).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    { key: 'pending/ws/agent/uuid.png', filename: 'diagram.png', contentType: 'image/png', byteSize: 3 },
  );
});
```

(Adjust the mock/render boilerplate to match whatever this file's existing tests already use — do not introduce a second test-rendering convention.)

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && pnpm test src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`
Expected: FAIL — `imagePlugin()` has no upload handler yet, so nothing calls `agentApi.requestUpload`.

- [ ] **Step 4: Wire the MDXEditor upload/preview handlers**

In `ArticleEditorSheet.tsx`, replace the bare `imagePlugin()` call (currently at the line the "No imageUploadHandler" comment sits above) with:

```tsx
imagePlugin({
  imageUploadHandler: async (file: File) => {
    const uploaded = await requestUpload(token, {
      filename: file.name,
      contentType: file.type,
      byteSize: file.size,
    });
    await putFileToUploadUrl(uploaded.upload_url, file);
    const { attachment } = await claimArticleAttachment(token, articleId, {
      key: uploaded.key,
      filename: file.name,
      contentType: file.type,
      byteSize: file.size,
    });
    setAttachments((current) => [...current, attachment]);
    return `attachment://${attachment.id}`;
  },
  imagePreviewHandler: async (src: string) => {
    if (!src.startsWith('attachment://')) return src;
    const id = src.slice('attachment://'.length);
    return attachments.find((a) => a.id === id)?.url ?? src;
  },
}),
```

Add `const [attachments, setAttachments] = useState<ArticleAttachmentView[]>(article.attachments ?? []);` near the sheet's other local state, and `import { claimArticleAttachment, requestUpload, putFileToUploadUrl } from '@/surfaces/agent-console/api/agentApi';` plus `import type { ArticleAttachmentView } from '@support/types';`.

Remove the "No imageUploadHandler" comment block — it is now stale.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pnpm test src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`
Expected: PASS.

- [ ] **Step 6: Manual check with `run`**

Start the app, open an existing draft article, use the editor's Insert Image toolbar button to upload a real PNG, save, and confirm the image renders inside the MDXEditor WYSIWYG view (via `imagePreviewHandler`) and again in the player-facing preview (via Task 4's `ArticleBody` change) after publishing.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx
git commit -m "Wire article image upload into the MDXEditor toolbar"
```
