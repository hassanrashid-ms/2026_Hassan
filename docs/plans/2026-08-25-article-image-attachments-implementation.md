# Article Image Attachments + Autosave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents upload images into knowledge-base articles, render them correctly on both the
agent-console editor and the player-facing webview, and replace the article editor's explicit
Create Draft / Save buttons with Google-Docs-style debounced autosave (Unsaved → Saving… → Saved),
including auto-creating the draft on the agent's very first keystroke.

**Supersedes:** `docs/plans/2026-08-24-article-image-upload-implementation.md`. That plan was
written but never implemented (`ArticleEditorSheet.tsx` still has no `imageUploadHandler` and
`articleAttachment` is still schema-only). It predates the autosave requirement entirely and used
a slightly different attachment-table shape (kept a `status` column, used `attachment://` as the
handle prefix, used `content_type` as a field name). This plan is the authoritative one going
forward — see Task 1's note at the top of the old file.

**Architecture:** Reuses the chat-attachment storage choke point unchanged (`presignPutObject`,
`headObject`, `copyObject`, `deleteObject`, `ALLOWED_IMAGE_MIME_TYPES`, `MAX_ATTACHMENT_BYTES` in
`backend/src/shared/storage/presign.ts`) and the existing generic `POST /agent/uploads` presign
endpoint. A new `POST /agent/articles/:id/attachments` claims a pending upload exactly the way
`sendAgentMessage` claims one for chat: ownership-prefix check → HEAD-verify → CopyObject to a
permanent key → insert an `article_attachment` row → best-effort delete of the pending original
after commit. `article_attachment` is simplified to mirror chat's `attachment` table shape exactly
(no `status` column, `storage_key`/`mime_type`/`byte_size` all `NOT NULL` — a row only ever exists
once verified).

Images are placed in markdown as `attachment:{attachmentId}` — a stable handle, never a URL, since
presigned GETs expire (10 min) and article bodies are permanent stored text. `GET /agent/articles/:id`
and `GET /surface/articles/:id` both gain `attachments: ArticleAttachmentView[]`, freshly presigned
at read time. The frontend resolves handles against that array — this is exactly the seam
`ArticleBody.tsx`'s existing `ArticleImage` component and its "SEAM" comment already anticipate.

**Deviation from the approved design spec, adopted here because it's a strict simplification:**
`docs/specs/2026-08-25-article-image-attachments-design.md` §4 proposed hand-written
`decodeArticleBodyForEditing`/`encodeArticleBodyForSaving` functions to bridge MDXEditor's WYSIWYG
canvas (which renders `<img src>` literally) and the `attachment:` handle scheme. MDXEditor's
`imagePlugin()` ships a purpose-built hook for exactly this — `imagePreviewHandler?: (imageSource:
string) => Promise<string>` (verified in `@mdxeditor/editor`'s type declarations) — called by the
editor whenever it needs to _display_ an image, on load and after insert. It only affects what's
rendered in the canvas; `getMarkdown()`/`onChange` still return the raw `attachment:{id}` text
untouched. That removes the need for both custom functions and the "encode" step entirely: the
stored markdown always contains handles, and `imagePreviewHandler` is the only place resolution
happens, looked up against the same `attachments` array the article-detail response already
carries. Task 8 below implements this instead of the spec's §4.

**Tech Stack:** Drizzle ORM, Express 5, Zod, `@aws-sdk/client-s3` (via the existing storage
choke point), React, `@mdxeditor/editor`, TanStack Query.

**Spec:** `docs/specs/2026-08-25-article-image-attachments-design.md` (all sections apply except
§4, superseded by the deviation above).

## Global Constraints

- Images only: `image/png`, `image/jpeg`, `image/webp`, `image/gif` — reuse
  `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` from `backend/src/shared/storage/presign.ts`,
  never redeclare them.
- Attachments may only be claimed onto an article in `draft` state (matches `updateArticle`'s
  existing draft-only rule).
- No hard deletes: no `DELETE` route for a claimed `article_attachment` row. An attachment no
  longer referenced by the body is harmless clutter — same accepted tradeoff as unsent chat
  uploads. No cleanup job.
- Object keys are server-generated UUIDs: `ws/{workspaceId}/attachments/{uuid}.{ext}` — identical
  prefix chat attachments already use; collisions are structurally impossible (UUIDs).
- All new/changed routes are registered in `backend/src/docs/openapi.ts`.
- `title`/`body` become optional-empty on `CreateArticleBody`/`UpdateArticleBody` (autosave must be
  able to save an article with an empty body); `publishArticle`'s empty-field rejection **already
  exists** in `backend/src/agent/services/articlesService.ts:136` — no backend change needed there,
  only a test confirming it (Task 5).
- Follow existing conventions exactly: RLS is structural (`workspace_id` column + `db:setup`, no
  manual policy), `404` not `403` for "not yours", `sendError(res, status, code, message)`,
  `logger` never `console.*`, Tailwind utilities only, no hand-written CSS.

---

### Task 1: Note the old plan as superseded

**Files:**

- Modify: `docs/plans/2026-08-24-article-image-upload-implementation.md`

- [ ] **Step 1: Add a superseded banner**

Insert this as the new first line of the file (before the `# Article Image Upload...` heading):

```markdown
> **SUPERSEDED by `docs/plans/2026-08-25-article-image-attachments-implementation.md`.** That plan
> covers the same feature plus autosave and uses a slightly different schema/handle scheme. Do not
> execute this file — kept for history only.
```

- [ ] **Step 2: Commit**

```bash
git add docs/plans/2026-08-24-article-image-upload-implementation.md
git commit -m "Mark superseded article-image-upload plan"
```

---

### Task 2: Simplify the `article_attachment` schema

**Files:**

- Modify: `backend/src/shared/db/schema/articles.ts`
- Modify: `backend/tests/helpers/db.ts`
- Test: `backend/tests/domain.articleAttachment.test.ts` (new)

**Interfaces:**

- Produces: `articleAttachment` Drizzle table (re-exported via `backend/src/shared/db/schema/index.ts`'s existing `export * from './articles.ts'`), columns `id, workspaceId, articleId, storageKey, filename, mimeType, byteSize, createdAt`. No `status` column.

- [ ] **Step 1: Rewrite the table**

In `backend/src/shared/db/schema/articles.ts`:

```ts
import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { articleState } from './enums.ts';
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
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate and apply the migration**

```bash
cd backend && pnpm db:generate
pnpm db:setup
```

Expected: a new file under `backend/drizzle/` dropping `status`, dropping the old nullable
`storage_key`/adding it back `NOT NULL`, and adding `mime_type`/`byte_size` `NOT NULL`. Since the
table has never had a row in any environment, drizzle-kit should emit a plain
`DROP COLUMN "status"` / `ALTER COLUMN "storage_key" SET NOT NULL` / two `ADD COLUMN ... NOT NULL`
statements with no data migration needed. `db:setup` exits 0.

- [ ] **Step 3: Add the table to the test-truncation list**

In `backend/tests/helpers/db.ts`, add `'article_attachment'` to `SCOPED_TABLES`, positioned before
`'article'` (dependent before parent, matching the file's existing ordering convention):

```ts
const SCOPED_TABLES = [
  'article_attachment',
  'article',
  // ...unchanged rest
];
```

- [ ] **Step 4: Write a failing test proving the new constraints**

`backend/tests/domain.articleAttachment.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

beforeEach(truncateAll);

describe('article_attachment table', () => {
  it('rejects a row with no matching article', async () => {
    const workspaceId = await seedWorkspace();
    await expect(
      ownerPool.query(
        `insert into article_attachment
           (workspace_id, article_id, storage_key, filename, mime_type, byte_size)
         values ($1, $2, 'ws/x/attachments/y.png', 'shot.png', 'image/png', 10)`,
        [workspaceId, randomUUID()],
      ),
    ).rejects.toThrow();
  });

  it('rejects a row with a null storage_key', async () => {
    const workspaceId = await seedWorkspace();
    const { rows: agentRows } = await ownerPool.query<{ id: string }>(
      `insert into agent (email, display_name) values ('a@example.test', 'A') returning id`,
    );
    const { rows: articleRows } = await ownerPool.query<{ id: string }>(
      `insert into article (workspace_id, title, body, created_by) values ($1, 't', 'b', $2) returning id`,
      [workspaceId, agentRows[0]!.id],
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
Expected: PASS — both constraints come from the migration in Step 2, not new application code;
this test proves the migration actually applied.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/db/schema/articles.ts backend/drizzle backend/tests/helpers/db.ts backend/tests/domain.articleAttachment.test.ts
git commit -m "Simplify article_attachment to mirror chat's attachment table"
```

---

### Task 3: Wire types — finalize body, attachment view, relaxed create/update

**Files:**

- Modify: `packages/types/src/articles.ts`

**Interfaces:**

- Produces:
  - `FinalizeArticleAttachmentBody = z.object({ key: z.string().min(1), filename: z.string().min(1).max(255), mime_type: z.string().min(1), byte_size: z.number().int().positive() })`
  - `ArticleAttachmentView = { id: string; filename: string; mime_type: string; byte_size: number; url: string | null }`
  - `AgentArticleDetail` and `PublicArticleDetail` each gain `attachments: ArticleAttachmentView[]`
  - `CreateArticleBody`/`UpdateArticleBody` `title`/`body` no longer require non-empty

- [ ] **Step 1: Add the finalize body and attachment view types**

In `packages/types/src/articles.ts`, add near the other article schemas:

```ts
export const FinalizeArticleAttachmentBody = z.object({
  key: z.string().min(1),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1),
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

- [ ] **Step 2: Relax create/update validation**

Change:

```ts
export const CreateArticleBody = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().optional(),
});

export const UpdateArticleBody = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().nullable().optional(),
});
```

to:

```ts
export const CreateArticleBody = z.object({
  title: z.string().max(200),
  body: z.string(),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().optional(),
});

export const UpdateArticleBody = z.object({
  title: z.string().max(200).optional(),
  body: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  intent_id: z.uuid().nullable().optional(),
});
```

(Drop `.min(1)` from both `title` and `body` on both schemas — an autosaved draft may legitimately
have an empty title or body until the agent types something. `publishArticle`'s existing
`empty_fields` check, `backend/src/agent/services/articlesService.ts:136`, remains the only place
non-empty content is enforced.)

- [ ] **Step 3: Add `attachments` to the detail types**

```ts
export type AgentArticleDetail = {
  id: string;
  title: string;
  body: string;
  keywords: string[];
  state: ArticleStateValue;
  intent_id: string | null;
  created_by: string;
  published_by: string | null;
  published_at: string | null;
  created_at: string;
  attachments: ArticleAttachmentView[];
};
```

```ts
export type PublicArticleDetail = {
  id: string;
  title: string;
  body: string;
  keywords: string[];
  intent_id: string | null;
  published_at: string | null;
  attachments: ArticleAttachmentView[];
};
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: fails in `backend/src/agent/services/articlesService.ts` and
`backend/src/surface/services/articlesService.ts` (both `toDetail` functions now return an object
missing the required `attachments` field) — this is intentional; Task 4 fixes it.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/articles.ts
git commit -m "Add article attachment types, relax create/update validation"
```

---

### Task 4: Finalize endpoint — `POST /agent/articles/:id/attachments`

**Files:**

- Modify: `backend/src/agent/services/articlesService.ts`
- Modify: `backend/src/agent/controllers/articlesController.ts`
- Modify: `backend/src/agent/routers/articlesRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Test: `backend/tests/agent.articles.test.ts` (extend)

**Interfaces:**

- Consumes: `headObject`, `copyObject`, `deleteObject`, `ALLOWED_IMAGE_MIME_TYPES`,
  `MAX_ATTACHMENT_BYTES` from `backend/src/shared/storage/presign.ts`; `articleAttachment` table
  (Task 2); `FinalizeArticleAttachmentBody` (Task 3).
- Produces: `finalizeArticleAttachment(ctx: AgentContext, articleId: string, body): Promise<FinalizeArticleAttachmentResult>` in `articlesService.ts`, result union `{ ok: true; attachment: ArticleAttachmentView } | { ok: false; reason: 'not_found' | 'not_draft' | 'attachment_not_found' | 'attachment_mismatch' }`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/agent.articles.test.ts` (add `import { randomUUID } from 'node:crypto';` and
`import { presignPutObject } from '../src/shared/storage/presign.ts';` at the top if not already
present; this file already has `seedWorkspace`/`seedAgent`/`app`/`ownerPool` set up for
`articlesRouter`, matching the pattern `agent.messages.test.ts` uses for chat's equivalent tests):

```ts
async function uploadFixtureImage(workspaceId: string, agentId: string) {
  const key = `pending/${workspaceId}/${agentId}/${randomUUID()}.png`;
  const body = Buffer.from('fake-png-bytes');
  const { url } = await presignPutObject({
    key,
    contentType: 'image/png',
    contentLength: body.length,
  });
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
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
      .expect(200);

    expect(res.body).toMatchObject({
      filename: 'diagram.png',
      mime_type: 'image/png',
      byte_size: 14,
    });
    expect(res.body.url).toBeTruthy();

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

    const res = await request(app)
      .post(`/articles/${created.body.id}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
      .expect(409);
    expect(res.body.error.code).toBe('invalid_request');
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
        mime_type: 'image/png',
        byte_size: 14,
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });

  it('422s with attachment_mismatch when declared byte_size disagrees with the real object', async () => {
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
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 999999 })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_mismatch');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: FAIL — 404, no such route yet.

- [ ] **Step 3: Implement the service function**

In `backend/src/agent/services/articlesService.ts`, add imports and the function (place after
`updateArticle`, before `publishArticle`):

```ts
import { randomUUID } from 'node:crypto';
import type { ArticleAttachmentView, FinalizeArticleAttachmentBody } from '@support/types';
import type { z } from 'zod';
import { article, articleAttachment, intent } from '../../shared/db/schema/index.ts';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  copyObject,
  headObject,
  presignGetObject,
} from '../../shared/storage/presign.ts';
```

```ts
export type FinalizeArticleAttachmentResult =
  | { ok: true; attachment: ArticleAttachmentView; pendingKey: string }
  | {
      ok: false;
      reason: 'not_found' | 'not_draft' | 'attachment_not_found' | 'attachment_mismatch';
    };

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export async function finalizeArticleAttachment(
  ctx: AgentContext,
  articleId: string,
  body: z.infer<typeof FinalizeArticleAttachmentBody>,
): Promise<FinalizeArticleAttachmentResult> {
  return withWorkspace(ctx.workspaceId, async (tx) => {
    const [existing] = await tx.select().from(article).where(eq(article.id, articleId)).limit(1);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (existing.state !== 'draft') return { ok: false, reason: 'not_draft' };

    // Same ownership-prefix check as sendAgentMessage's chat claim: only this
    // agent's own pending prefix may be claimed. A wrong-tenant/wrong-agent
    // key collapses into the same outcome as "missing".
    const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
    if (!body.key.startsWith(expectedPrefix)) {
      return { ok: false, reason: 'attachment_not_found' };
    }

    const real = await headObject(body.key);
    if (!real) return { ok: false, reason: 'attachment_not_found' };
    if (real.contentType !== body.mime_type || real.contentLength !== body.byte_size) {
      return { ok: false, reason: 'attachment_mismatch' };
    }
    // Defense-in-depth: re-check the allowlist/size cap against the
    // HEAD-verified values, not only the client-declared ones.
    if (
      !ALLOWED_IMAGE_MIME_TYPES.includes(
        real.contentType as (typeof ALLOWED_IMAGE_MIME_TYPES)[number],
      ) ||
      real.contentLength > MAX_ATTACHMENT_BYTES
    ) {
      return { ok: false, reason: 'attachment_mismatch' };
    }

    const destKey = `ws/${ctx.workspaceId}/attachments/${randomUUID()}.${extensionFor(real.contentType)}`;
    await copyObject({ sourceKey: body.key, destKey });

    const [row] = await tx
      .insert(articleAttachment)
      .values({
        workspaceId: ctx.workspaceId,
        articleId,
        storageKey: destKey,
        filename: body.filename,
        mimeType: body.mime_type,
        byteSize: body.byte_size,
      })
      .returning();

    return {
      ok: true,
      pendingKey: body.key,
      attachment: {
        id: row!.id,
        filename: row!.filename,
        mime_type: row!.mimeType,
        byte_size: row!.byteSize,
        url: await presignGetObject(destKey),
      },
    };
  });
}
```

(`presignGetObject` is called inside the transaction here purely to build the response — it's a
pure network call to the storage provider, not a DB operation, so it doesn't hold the transaction
open in any way that matters. Returning a signed `url` inline saves the editor a second round-trip,
per the design spec §2.)

- [ ] **Step 4: Implement the controller and route**

In `backend/src/agent/controllers/articlesController.ts`, add:

```ts
import { FinalizeArticleAttachmentBody } from '@support/types';
import { deleteObject } from '../../shared/storage/presign.ts';
import { finalizeArticleAttachment } from '../services/articlesService.ts';

export const finalizeArticleAttachmentHandler: RequestHandler = async (req, res) => {
  const params = ArticleIdParams.safeParse(req.params);
  const body = FinalizeArticleAttachmentBody.safeParse(req.body);
  if (!params.success || !body.success) {
    sendError(res, 422, 'invalid_request', 'key, filename, mime_type and byte_size are required.');
    return;
  }
  const result = await finalizeArticleAttachment(req.agent!, params.data.id, body.data);
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
      sendError(
        res,
        422,
        'attachment_not_found',
        'The uploaded file was not found or has expired.',
      );
      return;
    }
    sendError(
      res,
      422,
      'attachment_mismatch',
      'The uploaded file does not match its declared type or size.',
    );
    return;
  }
  // Best-effort, after the transaction committed — same reasoning as sendAgentMessage:
  // a transient storage error here must never surface as a failed finalize to the
  // agent once the row already exists.
  try {
    await deleteObject(result.pendingKey);
  } catch {
    // Logged inside deleteObject's callers elsewhere; safe to ignore here too —
    // an orphaned pending object is cheap and harmless.
  }
  res.status(200).json(result.attachment);
};
```

In `backend/src/agent/routers/articlesRouter.ts`, add the import and route:

```ts
import { finalizeArticleAttachmentHandler } from '../controllers/articlesController.ts';
// ...
articlesRouter.post('/articles/:id/attachments', finalizeArticleAttachmentHandler);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: PASS (all prior tests plus the 4 new ones).

- [ ] **Step 6: Register the route in OpenAPI**

In `backend/src/docs/openapi.ts`, near the other `/agent/articles*` registrations:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/articles/{id}/attachments',
  summary: 'Agent Finalize Article Attachment',
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
            mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
            byte_size: z.number().int().positive(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Attachment finalized' },
    404: { description: 'Article not found' },
    409: { description: 'Article is not a draft' },
    422: { description: 'Upload not found, expired, or mismatched' },
  },
});
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/src/agent/controllers/articlesController.ts backend/src/agent/routers/articlesRouter.ts backend/tests/agent.articles.test.ts backend/src/docs/openapi.ts
git commit -m "Add article attachment finalize endpoint"
```

---

### Task 5: Sign attachment URLs on article read (agent and player)

**Files:**

- Modify: `backend/src/agent/services/articlesService.ts`
- Modify: `backend/src/surface/services/articlesService.ts`
- Test: `backend/tests/agent.articles.test.ts` (extend), `backend/tests/surface.articles.test.ts` (extend)

**Interfaces:**

- Consumes: `presignGetObject` (Task 4's import already added agent-side); `articleAttachment` table.
- Produces: `getArticle` (agent) and the equivalent public detail function both return
  `attachments: ArticleAttachmentView[]`, satisfying the types added in Task 3.

- [ ] **Step 1: Write the failing agent-side test**

Add to `backend/tests/agent.articles.test.ts`:

```ts
describe('GET /agent/articles/:id with an attachment', () => {
  it('returns a fetchable presigned url for a finalized attachment', async () => {
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
      .send({ key, filename: 'diagram.png', mime_type: 'image/png', byte_size: 14 })
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
Expected: FAIL — `toDetail` doesn't return `attachments` yet (also currently a typecheck error from Task 3 Step 4).

- [ ] **Step 3: Implement signing in the agent service**

In `backend/src/agent/services/articlesService.ts`, replace `getArticle`:

```ts
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

    const attachments: ArticleAttachmentView[] = await Promise.all(
      attachmentRows.map(async (a) => ({
        id: a.id,
        filename: a.filename,
        mime_type: a.mimeType,
        byte_size: a.byteSize,
        url: await presignGetObject(a.storageKey).catch(() => null),
      })),
    );

    return { ...toDetail(row), attachments };
  });
}
```

(`toDetail` itself stays unchanged and keeps returning an object without `attachments` — it's
spread over here since signing needs a second query the row-mapper doesn't have access to. This
means `toDetail`'s return type alone no longer satisfies `AgentArticleDetail`; that's fine, only
`getArticle`'s return value needs to.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing player-facing test**

First read `backend/src/surface/services/articlesService.ts` to find its article-detail function's
exact name and `toDetail`-equivalent shape (not fetched during planning — confirm before editing).
Then add to `backend/tests/surface.articles.test.ts`, matching that file's existing
`fixture()`/`seedArticle()`-style helpers (also not confirmed during planning — match whatever
helpers the file already uses rather than inventing new ones):

```ts
import { randomUUID } from 'node:crypto';
import { presignPutObject } from '../src/shared/storage/presign.ts';
import { ownerPool } from './helpers/db.ts';

describe('GET /surface/articles/:id with an attachment', () => {
  it('returns a fetchable presigned url for a published article', async () => {
    const { workspaceId, token } = await fixture(); // match this file's actual setup helper
    const articleId = await seedArticle(workspaceId, { state: 'published' }); // match this file's actual seeding helper

    const key = `ws/${workspaceId}/attachments/${randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: body.length,
    });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
      body,
    });
    await ownerPool.query(
      `insert into article_attachment (workspace_id, article_id, storage_key, filename, mime_type, byte_size)
       values ($1, $2, $3, 'diagram.png', 'image/png', $4)`,
      [workspaceId, articleId, key, body.length],
    );

    const res = await request(app)
      .get(`/articles/${articleId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
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

Mirror Step 3's change in whichever function in `backend/src/surface/services/articlesService.ts`
powers `GET /surface/articles/:id` — join `articleAttachment` on `articleId`, map to
`ArticleAttachmentView[]` with `presignGetObject`, spread onto the returned detail object.

- [ ] **Step 8: Run both test files to verify they pass**

Run: `cd backend && pnpm test tests/agent.articles.test.ts tests/surface.articles.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the OpenAPI response schemas**

In `backend/src/docs/openapi.ts`, extend both the agent-detail and public-detail registered
response schemas with:

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

- [ ] **Step 10: Full typecheck**

Run: `pnpm typecheck`
Expected: 0 errors — Task 3's `AgentArticleDetail`/`PublicArticleDetail` additions are now
satisfied everywhere they're constructed.

- [ ] **Step 11: Commit**

```bash
git add backend/src/agent/services/articlesService.ts backend/src/surface/services/articlesService.ts backend/tests/agent.articles.test.ts backend/tests/surface.articles.test.ts backend/src/docs/openapi.ts
git commit -m "Sign article attachment URLs on read, agent and player"
```

---

### Task 6: Confirm publish's empty-field rejection (test only)

**Files:**

- Test: `backend/tests/agent.articles.test.ts` (extend)

**Interfaces:**

- Consumes: `publishArticle`'s existing `empty_fields` reason (`backend/src/agent/services/articlesService.ts:136`) and `publishArticleHandler`'s existing mapping of it to a 409 (`backend/src/agent/controllers/articlesController.ts`) — both pre-existing, unmodified by this plan.

This is the one place Task 3's relaxed Zod validation could silently create a gap: with `title`/
`body` now allowed empty at create/update time, publish must be the backstop. It already is — this
task only proves it, since Task 3 changes what previously would have been unreachable at the API
layer (a 422 from Zod) into a reachable 409 from the service.

- [ ] **Step 1: Write the test**

Add to `backend/tests/agent.articles.test.ts`:

```ts
describe('POST /agent/articles/:id/publish with empty fields', () => {
  it('409s when body is empty', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Refund policy', body: '' })
      .expect(201);

    const res = await request(app)
      .post(`/articles/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    expect(res.body.error.message).toMatch(/non-empty/i);
  });

  it('allows creating and updating a draft with an empty body', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId);
    const created = await request(app)
      .post('/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '', body: '' })
      .expect(201);
    expect(created.body.title).toBe('');

    await request(app)
      .patch(`/articles/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Now has a title' })
      .expect(200);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && pnpm test tests/agent.articles.test.ts`
Expected: PASS immediately — this proves Task 3 + the pre-existing `publishArticle` check compose
correctly, with no new backend code required.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/agent.articles.test.ts
git commit -m "Test: relaxed draft validation still blocks publish with empty fields"
```

---

### Task 7: Frontend — `attachment:` handle resolution in `ArticleBody`

**Files:**

- Modify: `frontend/src/features/articles/components/ArticleBody.tsx`
- Modify: `frontend/src/surfaces/webview/components/ArticleSheet.tsx`
- Test: `frontend/src/features/articles/components/ArticleBody.test.tsx` (new, unless one already exists — check first)

**Interfaces:**

- Consumes: `ArticleAttachmentView[]` from `@support/types` (Task 3).
- Produces: `ArticleBody` gains an `attachments?: ArticleAttachmentView[]` prop, default `[]`. No other prop changes — `MessageBody.tsx`'s existing call (chat markdown, never carries an `attachment:` handle) keeps working unchanged.

- [ ] **Step 1: Write the failing test**

```bash
ls frontend/src/features/articles/components/ArticleBody.test.tsx 2>/dev/null
```

If it doesn't exist, create it:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ArticleBody } from './ArticleBody.tsx';

describe('ArticleBody attachment resolution', () => {
  it('resolves an attachment: handle to its signed url', () => {
    render(
      <ArticleBody
        markdown="![diagram](attachment:a1)"
        attachments={[
          {
            id: 'a1',
            filename: 'diagram.png',
            mime_type: 'image/png',
            byte_size: 10,
            url: 'https://minio.local/signed',
          },
        ]}
      />,
    );
    expect(screen.getByAltText('diagram')).toHaveAttribute('src', 'https://minio.local/signed');
  });

  it('falls back to alt text when the handle has no matching attachment', () => {
    render(<ArticleBody markdown="![diagram](attachment:missing)" attachments={[]} />);
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
Expected: FAIL — no `attachments` prop exists yet; `attachment:a1` is passed straight to `<img src>` unresolved.

- [ ] **Step 3: Implement the resolution**

In `frontend/src/features/articles/components/ArticleBody.tsx`, add the import and update
`ArticleImage`, `getComponents`, and `ArticleBody`:

```tsx
import type { ArticleAttachmentView } from '@support/types';
```

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

  const resolvedSrc = src?.startsWith('attachment:')
    ? (attachments.find((a) => a.id === src.slice('attachment:'.length))?.url ?? undefined)
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
      className="mb-3 max-h-96 max-w-full rounded-card object-contain"
    />
  );
}
```

(`max-h-96` caps a huge/tall screenshot from dominating the article — same `object-contain`
treatment chat's `MessageBody` already uses at `max-h-64`; articles get a taller cap since they
render at a larger reading width than a chat bubble. `h-auto` alone had no ceiling, which is the
bleed the fixed cap fixes.)

```tsx
function getComponents(dark: boolean, attachments: ArticleAttachmentView[]): Components {
  // ...unchanged local consts (body/quote/rule/codeBg/link)...
  return {
    // ...unchanged entries (h1/h2/h3/p/ul/ol/li/blockquote/hr/code/pre)...
    img: ({ src, alt }) => (
      <ArticleImage
        src={typeof src === 'string' ? src : undefined}
        alt={alt}
        attachments={attachments}
      />
    ),
    // ...unchanged entries (table/th/td/a)...
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

- [ ] **Step 5: Wire the webview call site**

In `frontend/src/surfaces/webview/components/ArticleSheet.tsx`, the existing call is:

```tsx
<ArticleBody markdown={article.data.body} />
```

Change to:

```tsx
<ArticleBody markdown={article.data.body} attachments={article.data.attachments} />
```

(`article.data` is a `PublicArticleDetail`, which already carries `attachments` from Task 3/5 —
no other change needed in this file.)

- [ ] **Step 6: Confirm the chat call site is unaffected**

`frontend/src/features/chat/components/MessageBody.tsx` calls `<ArticleBody markdown={body} dark={dark} />` with no `attachments` prop — the default `[]` means any `attachment:` string in a bot/agent chat message (there shouldn't be one; chat images use the separate `ChatAttachment` mechanism, not markdown handles) degrades to the alt-text fallback rather than crashing. No change needed here; just confirm by reading the file that no `attachments` prop was added there.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/articles/components/ArticleBody.tsx frontend/src/features/articles/components/ArticleBody.test.tsx frontend/src/surfaces/webview/components/ArticleSheet.tsx
git commit -m "Resolve attachment: image handles in ArticleBody"
```

---

### Task 8: Frontend — autosave hook

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.ts`
- Test: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.test.ts` (new)

**Interfaces:**

- Consumes: `createArticle`, `updateArticle` from `frontend/src/surfaces/agent-console/api/agentApi.ts` (both already exist, unmodified).
- Produces (used by Task 9):

  ```ts
  type AutosaveStatus = 'unsaved' | 'saving' | 'saved';

  function useArticleAutosave(params: {
    token: string;
    articleId: string | null;
    onCreated: (id: string) => void;
    fields: { title: string; body: string; keywords: string[]; intentId: string | undefined };
  }): {
    status: AutosaveStatus;
    /** Resolves once a real articleId exists — creates synchronously (no debounce) if there isn't one yet. Used by the image upload handler in Task 9, which needs a real id before it can finalize an attachment. */
    ensureArticleId: () => Promise<string>;
    /** Flushes any pending debounced save immediately — call on sheet close. */
    flush: () => Promise<void>;
  };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentApi from '../../../api/agentApi.ts';
import { useArticleAutosave } from './useArticleAutosave.ts';

vi.mock('../../../api/agentApi.ts');

describe('useArticleAutosave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('creates a draft on the first edit, once, even if two fields change close together', async () => {
    vi.mocked(agentApi.createArticle).mockResolvedValue({
      id: 'new-id',
      title: 'T',
      body: '',
      keywords: [],
      state: 'draft',
      intent_id: null,
      created_by: 'a',
      published_by: null,
      published_at: null,
      created_at: new Date().toISOString(),
      attachments: [],
    });
    const onCreated = vi.fn();

    const { result, rerender } = renderHook(
      (fields) => useArticleAutosave({ token: 't', articleId: null, onCreated, fields }),
      { initialProps: { title: '', body: '', keywords: [], intentId: undefined } },
    );

    rerender({ title: 'T', body: '', keywords: [], intentId: undefined });
    rerender({ title: 'T', body: 'B', keywords: [], intentId: undefined });

    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      vi.advanceTimersByTime(800);
    });

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-id'));
    expect(agentApi.createArticle).toHaveBeenCalledTimes(1);
  });

  it('goes unsaved -> saving -> saved for an update on an existing draft', async () => {
    vi.mocked(agentApi.updateArticle).mockResolvedValue({
      id: 'a1',
      title: 'T2',
      body: 'B',
      keywords: [],
      state: 'draft',
      intent_id: null,
      created_by: 'a',
      published_by: null,
      published_at: null,
      created_at: new Date().toISOString(),
      attachments: [],
    });

    const { result, rerender } = renderHook(
      (fields) => useArticleAutosave({ token: 't', articleId: 'a1', onCreated: vi.fn(), fields }),
      { initialProps: { title: 'T', body: 'B', keywords: [], intentId: undefined } },
    );
    expect(result.current.status).toBe('saved');

    rerender({ title: 'T2', body: 'B', keywords: [], intentId: undefined });
    expect(result.current.status).toBe('unsaved');

    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    await waitFor(() => expect(result.current.status).toBe('saved'));
    expect(agentApi.updateArticle).toHaveBeenCalledWith('t', 'a1', {
      title: 'T2',
      body: 'B',
      keywords: [],
      intent_id: null,
    });
  });

  it('ensureArticleId creates synchronously, bypassing the debounce, when there is no id yet', async () => {
    vi.mocked(agentApi.createArticle).mockResolvedValue({
      id: 'new-id',
      title: '',
      body: '',
      keywords: [],
      state: 'draft',
      intent_id: null,
      created_by: 'a',
      published_by: null,
      published_at: null,
      created_at: new Date().toISOString(),
      attachments: [],
    });

    const { result } = renderHook(() =>
      useArticleAutosave({
        token: 't',
        articleId: null,
        onCreated: vi.fn(),
        fields: { title: '', body: '', keywords: [], intentId: undefined },
      }),
    );

    const id = await act(() => result.current.ensureArticleId());
    expect(id).toBe('new-id');
    expect(agentApi.createArticle).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm test src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the hook**

```ts
import { useEffect, useRef, useState } from 'react';
import type { AgentArticleDetail } from '@support/types';
import { createArticle, updateArticle } from '../../../api/agentApi.ts';

export type AutosaveStatus = 'unsaved' | 'saving' | 'saved';

type Fields = { title: string; body: string; keywords: string[]; intentId: string | undefined };

const DEBOUNCE_MS = 800;

export function useArticleAutosave(params: {
  token: string;
  articleId: string | null;
  onCreated: (id: string) => void;
  fields: Fields;
}): {
  status: AutosaveStatus;
  ensureArticleId: () => Promise<string>;
  flush: () => Promise<void>;
} {
  const { token, onCreated } = params;
  const [status, setStatus] = useState<AutosaveStatus>('saved');

  // Refs, not state: this data must be read inside a debounced timeout closure
  // without re-triggering the effect that schedules it.
  const articleIdRef = useRef<string | null>(params.articleId);
  const fieldsRef = useRef<Fields>(params.fields);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<string> | null>(null);
  const firstRunRef = useRef(true);

  useEffect(() => {
    articleIdRef.current = params.articleId;
  }, [params.articleId]);

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
    } else {
      await updateArticle(token, articleIdRef.current, body);
    }
    setStatus('saved');
  }

  useEffect(() => {
    const changed =
      fieldsRef.current.title !== params.fields.title ||
      fieldsRef.current.body !== params.fields.body ||
      fieldsRef.current.keywords.join(',') !== params.fields.keywords.join(',') ||
      fieldsRef.current.intentId !== params.fields.intentId;
    fieldsRef.current = params.fields;

    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    if (!changed) return;

    setStatus('unsaved');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      // A concurrent ensureArticleId() create already in flight wins — this
      // debounced save waits for it rather than racing a second create.
      const wait = inFlightRef.current ?? Promise.resolve('');
      const run = wait.then(() => persist(fieldsRef.current));
      inFlightRef.current = run.then(() => articleIdRef.current!);
    }, DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.fields.title, params.fields.body, params.fields.keywords, params.fields.intentId]);

  async function ensureArticleId(): Promise<string> {
    if (articleIdRef.current !== null) return articleIdRef.current;
    if (inFlightRef.current) return inFlightRef.current;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const run = persist(fieldsRef.current).then(() => articleIdRef.current!);
    inFlightRef.current = run;
    return run;
  }

  async function flush(): Promise<void> {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    await persist(fieldsRef.current);
  }

  return { status, ensureArticleId, flush };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd frontend && pnpm test src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.ts frontend/src/surfaces/agent-console/pages/KnowledgeBase/hooks/useArticleAutosave.test.ts
git commit -m "Add Google-Docs-style autosave hook for the article editor"
```

---

### Task 9: Frontend — image upload API + preview resolution wiring

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Consumes: `requestUpload`, `putFileToUploadUrl` (both already exist, unmodified).
- Produces: `finalizeArticleAttachment(token, articleId, input): Promise<ArticleAttachmentView>` — used by Task 10.

- [ ] **Step 1: Add the finalize API function**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, add near the other article functions:

```ts
export function finalizeArticleAttachment(
  token: string,
  articleId: string,
  input: { key: string; filename: string; mimeType: string; byteSize: number },
): Promise<ArticleAttachmentView> {
  return call(`/agent/articles/${articleId}/attachments`, token, {
    method: 'POST',
    body: JSON.stringify({
      key: input.key,
      filename: input.filename,
      mime_type: input.mimeType,
      byte_size: input.byteSize,
    }),
  });
}
```

Add `ArticleAttachmentView` to the file's existing `@support/types` type-only import.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Add finalizeArticleAttachment API client function"
```

---

### Task 10: Frontend — wire autosave and image upload into `ArticleEditorSheet`

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx` (extend if it exists, else check `KnowledgeBase.test.tsx` for the existing coverage pattern first — do not invent a new test-rendering convention)

**Interfaces:**

- Consumes: `useArticleAutosave` (Task 8), `finalizeArticleAttachment` (Task 9), `requestUpload`/`putFileToUploadUrl` (pre-existing), MDXEditor's `imagePlugin({ imageUploadHandler, imagePreviewHandler })`.
- Produces: none consumed elsewhere — terminal UI task.

- [ ] **Step 1: Write the failing test for autosave status display**

Check the existing test file's render/mock setup, then add (adjust boilerplate to match):

```tsx
it('shows Unsaved then Saved as the agent types, with no Save button', async () => {
  vi.mocked(agentApi.updateArticle).mockResolvedValue({/* ...existing draft article shape... */});
  // ...render the sheet with an existing draft article, matching this file's existing setup...

  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Create Draft' })).not.toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('Article title'), {
    target: { value: 'New title' },
  });
  expect(screen.getByText('Unsaved')).toBeInTheDocument();

  vi.advanceTimersByTime(800);
  await screen.findByText('Saved');
});

it('uploads an image and inserts an attachment: reference into the body', async () => {
  vi.mocked(agentApi.requestUpload).mockResolvedValue({
    key: 'pending/ws/agent/uuid.png',
    upload_url: 'https://minio.local/put',
    expires_at: new Date().toISOString(),
  });
  vi.mocked(agentApi.putFileToUploadUrl).mockResolvedValue(undefined);
  vi.mocked(agentApi.finalizeArticleAttachment).mockResolvedValue({
    id: 'a1',
    filename: 'diagram.png',
    mime_type: 'image/png',
    byte_size: 3,
    url: 'https://minio.local/signed',
  });

  // ...render the sheet with a draft article, matching this file's existing setup...

  const file = new File([new Uint8Array(3)], 'diagram.png', { type: 'image/png' });
  const input = screen.getByLabelText('Insert image'); // MDXEditor's InsertImage toolbar control
  fireEvent.change(input, { target: { files: [file] } });

  await screen.findByAltText('diagram.png');
  expect(agentApi.finalizeArticleAttachment).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    {
      key: 'pending/ws/agent/uuid.png',
      filename: 'diagram.png',
      mimeType: 'image/png',
      byteSize: 3,
    },
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm test src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`
Expected: FAIL — no autosave status text exists, `imagePlugin()` has no upload handler.

- [ ] **Step 3: Wire autosave into `ArticleEditorForm`**

In `ArticleEditorSheet.tsx`, replace the `createDraft`/`saveDraft` mutations and the footer's
Create Draft / Save buttons. Add near the top of `ArticleEditorForm`:

```tsx
import { useArticleAutosave } from '../hooks/useArticleAutosave.ts';
import type { ArticleAttachmentView } from '@support/types';
```

```tsx
const [attachments, setAttachments] = useState<ArticleAttachmentView[]>(article?.attachments ?? []);
const [resolvedArticleId, setResolvedArticleId] = useState(articleId);

const autosave = useArticleAutosave({
  token,
  articleId: resolvedArticleId,
  onCreated: (id) => {
    setResolvedArticleId(id);
    invalidateArticles();
    onCreated(id);
  },
  fields: {
    title: draft.title,
    body: draft.body,
    keywords: parseKeywordsInput(draft.keywordsInput),
    intentId: draft.intentId || undefined,
  },
});

useEffect(() => {
  return () => {
    void autosave.flush();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Remove the `createDraft` and `saveDraft` `useMutation` blocks entirely — autosave replaces both.
`publish`/`archive` mutations are unchanged (they still act on `articleId`/`resolvedArticleId`).

Replace the footer's `articleId === null ? <Create Draft button> : <Save/Archive/Publish buttons>`
branch with:

```tsx
<div className="flex items-center gap-2 text-xs text-muted">
  {autosave.status === 'unsaved' && 'Unsaved'}
  {autosave.status === 'saving' && 'Saving…'}
  {autosave.status === 'saved' && 'Saved'}
</div>
<Button
  type="button"
  variant="outline"
  onClick={() => archive.mutate()}
  disabled={resolvedArticleId === null || archive.isPending}
>
  Archive
</Button>
<Button
  type="button"
  onClick={() => publish.mutate()}
  disabled={
    resolvedArticleId === null ||
    !canPublish(state, draft.title, draft.body) ||
    publish.isPending
  }
>
  Publish
</Button>
```

(`publish`/`archive` mutations' `mutationFn`s must reference `resolvedArticleId!` instead of
`articleId!` now, since a brand-new sheet has no `articleId` prop but gains one via autosave.)

- [ ] **Step 4: Wire the MDXEditor upload/preview handlers**

Replace the bare `imagePlugin()` call (the one with the "No imageUploadHandler" comment) with:

```tsx
imagePlugin({
  imageUploadHandler: async (file: File) => {
    const id = await autosave.ensureArticleId();
    const uploaded = await requestUpload(token, {
      filename: file.name,
      contentType: file.type,
      byteSize: file.size,
    });
    await putFileToUploadUrl(uploaded.upload_url, file);
    const attachment = await finalizeArticleAttachment(token, id, {
      key: uploaded.key,
      filename: file.name,
      mimeType: file.type,
      byteSize: file.size,
    });
    setAttachments((current) => [...current, attachment]);
    return `attachment:${attachment.id}`;
  },
  imagePreviewHandler: async (src: string) => {
    if (!src.startsWith('attachment:')) return src;
    const id = src.slice('attachment:'.length);
    return attachments.find((a) => a.id === id)?.url ?? src;
  },
}),
```

Add the imports:

```tsx
import {
  finalizeArticleAttachment,
  putFileToUploadUrl,
  requestUpload,
} from '../../../api/agentApi.ts';
```

Remove the stale "No imageUploadHandler — there's no upload endpoint..." comment block above the
old `imagePlugin()` call.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && pnpm test src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: 0 errors.

- [ ] **Step 7: Manual browser check**

Use the `run` skill to start the app (`pnpm dev`). In the agent console:

1. Open a brand-new article (no existing draft) and type a single character into the title field.
   Confirm the status indicator shows "Unsaved" then "Saving…" then "Saved" within ~1s, with no
   Create Draft button anywhere.
2. Use the Insert Image toolbar button to upload a real PNG. Confirm it appears in the MDXEditor
   canvas immediately (via `imagePreviewHandler`), with no reload.
3. Close the sheet and reopen the same draft. Confirm the previously uploaded image still renders
   live in the canvas (this proves `imagePreviewHandler` resolves handles on load, not only
   immediately after upload).
4. Publish the article, then open it in the webview player surface. Confirm the image renders
   there via `ArticleBody`'s `attachment:` resolution (Task 7).

- [ ] **Step 8: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleEditorSheet.test.tsx
git commit -m "Replace article Create/Save buttons with autosave; wire image upload"
```
