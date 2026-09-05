# Bulk Import Markdown Articles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Team Lead/Admin upload a `.zip` of markdown files in the agent console and have each `.md`/`.markdown` entry become a new draft article, per `docs/specs/2026-09-01-bulk-import-markdown-articles-design.md`.

**Architecture:** Client uploads the zip directly to storage via the existing presigned-PUT flow (generalized to accept `application/zip` alongside images/video), then calls a new `POST /agent/articles/bulk-import { key }` endpoint. The server fetches the object into memory, unzips with `jszip`, filters to `.md`/`.markdown` entries, parses each with `front-matter` (mirroring the existing client-side single-file import logic), and calls the existing `createArticle()` service once per entry — independently, best-effort. The response is a per-file result list the UI renders as a table.

**Tech Stack:** Express 5 + TypeScript + Zod (backend), Drizzle/Postgres (unchanged — no schema change), `jszip` + `front-matter` (new/reused deps), React + TanStack Query + shadcn/ui (frontend), Vitest for both.

## Global Constraints

- Zip cap: ≤ 20MB (`MAX_IMPORT_ZIP_BYTES`). Over this → reject upfront, nothing created.
- File-count cap: ≤ 200 `.md`/`.markdown` entries (`MAX_IMPORT_FILES`). Over this → reject upfront, nothing created.
- Only `.md`/`.markdown` entries (case-insensitive) are read; everything else in the zip (folders, images, `.DS_Store`) is silently skipped, never reported.
- Every successfully parsed entry becomes one article with `state: draft`, `intent_id: null`. Nothing is ever published by this feature.
- Best-effort per file: one bad entry never blocks the rest of the batch. No transaction spans multiple files.
- Endpoint restricted to Team Lead + Admin via the existing `requireTeamLeadOrAdmin` middleware.
- Title resolution: `frontmatter.title` → first `# H1` line in the body → entry's basename (extension stripped, path flattened). Truncate to 200 chars (schema max) rather than failing the file.
- Keywords: `frontmatter.tags` (array or comma-separated string, deduped), `[]` if absent.
- No hard deletes, no proxying large uploads through Node (zip still goes client → storage directly via presigned PUT) — per repo-wide `CLAUDE.md` rules.
- Every new API endpoint gets registered in `backend/src/docs/openapi.ts`.

---

### Task 1: Generalize upload validation to accept zip imports

**Files:**

- Modify: `backend/src/shared/storage/presign.ts`
- Modify: `backend/src/agent/services/uploadsService.ts`
- Modify: `backend/src/agent/controllers/uploadsController.ts`
- Test: `backend/tests/uploadsService.test.ts` (create if it doesn't already cover this; check first — if a test file already exists for `uploadsService.ts`, add to it instead)

**Interfaces:**

- Produces (used by Task 5 and Task 7): `ALLOWED_IMPORT_MIME_TYPES: readonly string[]`, `MAX_IMPORT_ZIP_BYTES: number`, `isAllowedUploadMimeType(contentType: string): boolean`, `maxBytesForUpload(contentType: string): number`, `getObjectBuffer(key: string): Promise<Buffer>` — all exported from `backend/src/shared/storage/presign.ts`.

Currently `POST /uploads` only accepts image/video MIME types (`ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`) via `uploadsService.requestUpload`. This task widens that check to also accept zip uploads, with their own size cap, without changing behavior for existing image/video uploads.

- [ ] **Step 1: Check for an existing uploadsService test file**

```bash
ls backend/tests/ | grep -i upload
```

If a file like `backend/tests/agent.uploads.test.ts` or `uploadsService.test.ts` exists, note its path and import/mocking style — you'll add new `describe` blocks to it in Step 2 instead of creating a new file.

- [ ] **Step 2: Write the failing tests**

Add to the existing uploads test file (or create `backend/tests/uploadsService.test.ts` using the same `describe`/`it`/vitest style as `backend/tests/agent.articles.test.ts` if none exists — import `requestUpload` from `../src/agent/services/uploadsService.ts` directly, no HTTP layer needed for a unit test):

```typescript
import { describe, expect, it } from 'vitest';
import { requestUpload } from '../src/agent/services/uploadsService.ts';

describe('requestUpload — zip imports', () => {
  it('accepts application/zip up to the import size cap', async () => {
    const ctx = { agentId: 'a', workspaceId: 'w', isAdmin: false };
    const result = await requestUpload(ctx, {
      filename: 'articles.zip',
      content_type: 'application/zip',
      byte_size: 10 * 1024 * 1024,
    });
    expect(result.outcome).toBe('ok');
  });

  it('rejects application/zip over the 20MB import cap', async () => {
    const ctx = { agentId: 'a', workspaceId: 'w', isAdmin: false };
    const result = await requestUpload(ctx, {
      filename: 'articles.zip',
      content_type: 'application/zip',
      byte_size: 21 * 1024 * 1024,
    });
    expect(result.outcome).toBe('too_large');
  });

  it('still rejects unrelated mime types', async () => {
    const ctx = { agentId: 'a', workspaceId: 'w', isAdmin: false };
    const result = await requestUpload(ctx, {
      filename: 'notes.txt',
      content_type: 'text/plain',
      byte_size: 100,
    });
    expect(result.outcome).toBe('invalid_media_type');
  });

  it('still accepts images under the existing 10MB cap unchanged', async () => {
    const ctx = { agentId: 'a', workspaceId: 'w', isAdmin: false };
    const result = await requestUpload(ctx, {
      filename: 'photo.png',
      content_type: 'image/png',
      byte_size: 5 * 1024 * 1024,
    });
    expect(result.outcome).toBe('ok');
  });
});
```

- [ ] **Step 2b: Run the tests to verify they fail**

```bash
cd backend && pnpm vitest run tests/uploadsService.test.ts
```

Expected: the zip-related tests FAIL (`content_type` not in `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`, so `requestUpload` currently returns `invalid_media_type` for `application/zip`).

- [ ] **Step 3: Add the zip allowlist, size cap, generalized helpers, and object-fetch helper to `presign.ts`**

In `backend/src/shared/storage/presign.ts`, after the existing `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`/`maxBytesForAttachment` block, add:

```typescript
export const ALLOWED_IMPORT_MIME_TYPES = [
  'application/zip',
  'application/x-zip-compressed',
] as const;

export const MAX_IMPORT_ZIP_BYTES = 20 * 1024 * 1024;

/** Every content type POST /uploads is willing to presign a PUT for. */
export function isAllowedUploadMimeType(contentType: string): boolean {
  return (
    (ALLOWED_CHAT_ATTACHMENT_MIME_TYPES as readonly string[]).includes(contentType) ||
    (ALLOWED_IMPORT_MIME_TYPES as readonly string[]).includes(contentType)
  );
}

/** Size cap for POST /uploads, branching by which allowlist the content type falls in. */
export function maxBytesForUpload(contentType: string): number {
  if ((ALLOWED_IMPORT_MIME_TYPES as readonly string[]).includes(contentType)) {
    return MAX_IMPORT_ZIP_BYTES;
  }
  return maxBytesForAttachment(contentType);
}
```

At the bottom of the same file, after `deleteObject`, add:

```typescript
/**
 * Reads an object fully into memory. Only used for the bulk-import zip path —
 * every other consumer of this module streams via presigned URLs and never
 * touches the bytes from Node. Zips are capped at MAX_IMPORT_ZIP_BYTES, so an
 * in-memory buffer is fine here.
 */
export async function getObjectBuffer(key: string): Promise<Buffer> {
  const env = getEnv();
  const result = await getS3Client().send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  const bytes = await result.Body!.transformToByteArray();
  return Buffer.from(bytes);
}
```

- [ ] **Step 4: Wire the new helpers into `uploadsService.ts` and `uploadsController.ts`**

In `backend/src/agent/services/uploadsService.ts`, change the imports and the body of `requestUpload`:

```typescript
import {
  isAllowedUploadMimeType,
  maxBytesForUpload,
  deleteObject,
  presignPutObject,
} from '../../shared/storage/presign.ts';
```

Replace the two checks inside `requestUpload`:

```typescript
export async function requestUpload(
  ctx: AgentContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (!isAllowedUploadMimeType(body.content_type)) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > maxBytesForUpload(body.content_type)) {
    return { outcome: 'too_large' };
  }

  const key = buildPendingKey(ctx.workspaceId, ctx.agentId, body.content_type);
  const { url, expiresAt } = await presignPutObject({
    key,
    contentType: body.content_type,
    contentLength: body.byte_size,
  });
  return { outcome: 'ok', key, upload_url: url, expires_at: expiresAt };
}
```

`buildPendingKey`'s `extensionFor` helper needs a `.zip` case too — in the same file:

```typescript
export function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    case 'application/zip':
    case 'application/x-zip-compressed':
      return 'zip';
    default:
      return 'bin';
  }
}
```

In `backend/src/agent/controllers/uploadsController.ts`, update the import and the pre-check:

```typescript
import { maxBytesForUpload } from '../../shared/storage/presign.ts';
```

```typescript
if (body.data.byte_size > maxBytesForUpload(body.data.content_type)) {
  sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
  return;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && pnpm vitest run tests/uploadsService.test.ts
```

Expected: PASS, all four cases.

- [ ] **Step 6: Run the full backend suite to check for regressions in existing upload/attachment tests**

```bash
cd backend && pnpm vitest run tests/agent.articles.test.ts
```

Expected: PASS unchanged (image upload behavior is untouched — `maxBytesForUpload`/`isAllowedUploadMimeType` return identical results to the old direct calls for every non-zip content type).

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/storage/presign.ts backend/src/agent/services/uploadsService.ts backend/src/agent/controllers/uploadsController.ts backend/tests/uploadsService.test.ts
git commit -m "Allow zip uploads through the presigned-upload flow for bulk article import"
```

---

### Task 2: Pure markdown-entry parser for bulk import

**Files:**

- Create: `backend/src/agent/services/articleMarkdownImport.ts`
- Test: `backend/tests/articleMarkdownImport.test.ts`

**Interfaces:**

- Produces (used by Task 4): `parseMarkdownEntry(content: string, filename: string): ParsedMarkdownEntry`, `MAX_IMPORT_FILES: number`, and the type `ParsedMarkdownEntry = { error: null; title: string; body: string; keywords: string[] } | { error: string }`.

This mirrors the existing frontend `parseMarkdownImport` (`frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts`) but as a server-side pure function — frontend and backend don't share code outside `packages/types`, so this is a deliberate, small, parallel implementation, not a bug.

- [ ] **Step 1: Add the `front-matter` dependency to the backend**

```bash
cd backend && pnpm add front-matter
```

- [ ] **Step 2: Write the failing tests**

Create `backend/tests/articleMarkdownImport.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseMarkdownEntry } from '../src/agent/services/articleMarkdownImport.ts';

describe('parseMarkdownEntry', () => {
  it('reads title and tags from frontmatter, leaving the rest as body', () => {
    const content = [
      '---',
      'title: Refund Policy',
      'tags: [refund, billing]',
      '---',
      '# Refund Policy',
      '',
      'We refund within 30 days.',
    ].join('\n');

    const result = parseMarkdownEntry(content, 'refund-policy.md');

    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('Refund Policy');
    expect(result.keywords).toEqual(['refund', 'billing']);
    expect(result.body).toContain('We refund within 30 days.');
  });

  it('falls back to the first H1 when frontmatter has no title', () => {
    const content = '# Getting Started\n\nSome body text.';
    const result = parseMarkdownEntry(content, 'ignored.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('Getting Started');
  });

  it('falls back to the filename when there is no frontmatter title or H1', () => {
    const content = 'Just some plain text, no heading.';
    const result = parseMarkdownEntry(content, 'nested/path/my-article.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('my-article.md');
  });

  it('parses comma-separated string tags and dedupes them', () => {
    const content = '---\ntitle: X\ntags: "billing, billing, refund"\n---\nBody.';
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.keywords).toEqual(['billing', 'refund']);
  });

  it('truncates a title longer than 200 characters instead of failing', () => {
    const longTitle = 'x'.repeat(250);
    const content = `---\ntitle: ${longTitle}\n---\nBody.`;
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toHaveLength(200);
  });

  it('errors on a file that is empty after stripping frontmatter', () => {
    const content = '---\ntitle: X\n---\n   \n';
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBe('empty_file');
  });

  it('treats malformed frontmatter as plain body, falling back on title', () => {
    const content = '---\ntitle: [unterminated\n# Fallback Title\nBody text.';
    const result = parseMarkdownEntry(content, 'x.md');
    expect(result.error).toBeNull();
    if (result.error !== null) throw new Error('unreachable');
    expect(result.title).toBe('Fallback Title');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
cd backend && pnpm vitest run tests/articleMarkdownImport.test.ts
```

Expected: FAIL — `articleMarkdownImport.ts` does not exist yet.

- [ ] **Step 4: Implement `parseMarkdownEntry`**

Create `backend/src/agent/services/articleMarkdownImport.ts`:

```typescript
import fm from 'front-matter';

export const MAX_IMPORT_FILES = 200;
const MAX_TITLE_LENGTH = 200;

export type ParsedMarkdownEntry =
  { error: null; title: string; body: string; keywords: string[] } | { error: string };

function titleFromContent(body: string, filename: string): string {
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1]!.trim();
  return filename
    .split('/')
    .pop()!
    .replace(/\.[^/.]+$/, '');
}

/**
 * Server-side counterpart to the frontend's parseMarkdownImport
 * (frontend/src/surfaces/agent-console/pages/KnowledgeBase/articleForm.ts).
 * Kept as a separate implementation deliberately — frontend/backend share
 * code only through packages/types.
 */
export function parseMarkdownEntry(content: string, filename: string): ParsedMarkdownEntry {
  let attributes: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = fm<Record<string, unknown>>(content);
    attributes = parsed.attributes ?? {};
    body = parsed.body;
  } catch {
    body = content;
  }

  body = body.trim();
  if (body === '') return { error: 'empty_file' };

  const rawTitle = attributes.title;
  let title =
    typeof rawTitle === 'string' && rawTitle.trim() !== ''
      ? rawTitle.trim()
      : titleFromContent(body, filename);
  if (title.length > MAX_TITLE_LENGTH) title = title.slice(0, MAX_TITLE_LENGTH);

  const rawTags = attributes.tags;
  let keywords: string[] = [];
  if (Array.isArray(rawTags)) {
    keywords = rawTags.filter((tag): tag is string => typeof tag === 'string');
  } else if (typeof rawTags === 'string') {
    const seen = new Set<string>();
    for (const part of rawTags.split(',')) {
      const trimmed = part.trim();
      if (trimmed !== '') seen.add(trimmed);
    }
    keywords = [...seen];
  }

  return { error: null, title, body, keywords };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd backend && pnpm vitest run tests/articleMarkdownImport.test.ts
```

Expected: PASS, all 7 cases.

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/pnpm-lock.yaml backend/src/agent/services/articleMarkdownImport.ts backend/tests/articleMarkdownImport.test.ts
git commit -m "Add server-side markdown-entry parser for bulk article import"
```

---

### Task 3: Add wire-contract types for bulk import

**Files:**

- Modify: `packages/types/src/articles.ts`

**Interfaces:**

- Produces (used by Task 4, Task 5, Task 7): `BulkImportArticlesBody` (Zod schema), `BulkImportArticleResult`, `BulkImportArticlesResponse` (TS types).

- [ ] **Step 1: Add the schema and types**

In `packages/types/src/articles.ts`, near `CreateArticleBody`, add:

```typescript
export const BulkImportArticlesBody = z.object({
  key: z.string().min(1),
});

export type BulkImportArticleResult =
  | { filename: string; status: 'created'; title: string; article_id: string }
  | { filename: string; status: 'error'; reason: string };

export type BulkImportArticlesResponse = {
  results: BulkImportArticleResult[];
  summary: { total: number; created: number; failed: number };
};
```

- [ ] **Step 2: Typecheck the types package**

```bash
cd packages/types && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/articles.ts
git commit -m "Add BulkImportArticlesBody/Response wire types"
```

---

### Task 4: `bulkImportArticles` service function

**Files:**

- Modify: `backend/src/agent/services/articlesService.ts`
- Modify: `backend/src/errors.ts`
- Test: `backend/tests/agent.articles.bulkImport.test.ts`

**Interfaces:**

- Consumes: `createArticle(ctx: AgentContext, input: CreateArticleInput): Promise<CreateArticleResult>` (existing, unchanged), `parseMarkdownEntry`, `MAX_IMPORT_FILES` (Task 2), `getObjectBuffer`, `headObject`, `deleteObject` (Task 1/existing), `BulkImportArticleResult`, `BulkImportArticlesResponse` (Task 3).
- Produces (used by Task 5): `bulkImportArticles(ctx: AgentContext, key: string): Promise<BulkImportArticlesResult>` where `BulkImportArticlesResult = { ok: true; results: BulkImportArticleResult[]; summary: { total: number; created: number; failed: number } } | { ok: false; reason: 'not_found' | 'invalid_zip' | 'no_markdown_files' | 'too_many_files' }`.

- [ ] **Step 1: Add the `jszip` dependency**

```bash
cd backend && pnpm add jszip
```

- [ ] **Step 2: Add new error codes**

In `backend/src/errors.ts`, add to the `ErrorCode` union (alongside `'unsupported_media_type'`):

```typescript
  | 'invalid_zip'
  | 'no_markdown_files'
  | 'too_many_files'
```

- [ ] **Step 3: Write the failing integration test**

Create `backend/tests/agent.articles.bulkImport.test.ts`, following the exact setup pattern of `backend/tests/agent.articles.test.ts` (same imports, same `app`, same `beforeAll`/`afterAll`/`beforeEach`, same `seedWorkspace`/`seedAgent` helpers — copy that boilerplate verbatim into this file's top, including the `vi.mock('../src/shared/weaviate/articlesIndex.ts', ...)` mock, since `createArticle` doesn't touch Weaviate but other article routes registered on the same router do get exercised). Add a zip-fixture helper mirroring `uploadFixtureImage`:

```typescript
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { presignPutObject } from '../src/shared/storage/presign.ts';

async function uploadFixtureZip(
  workspaceId: string,
  agentId: string,
  files: Record<string, string>,
): Promise<string> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  const body = await zip.generateAsync({ type: 'nodebuffer' });
  const key = `pending/${workspaceId}/${agentId}/${randomUUID()}.zip`;
  const { url } = await presignPutObject({
    key,
    contentType: 'application/zip',
    contentLength: body.length,
  });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/zip', 'Content-Length': String(body.length) },
    body,
  });
  return key;
}
```

Then the test cases, calling the service function directly (not yet wired to a route — that's Task 5):

```typescript
import { bulkImportArticles } from '../src/agent/services/articlesService.ts';

describe('bulkImportArticles', () => {
  it('creates one draft article per .md entry, skipping non-md entries', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, {
      'a.md': '---\ntitle: Article A\n---\nBody A.',
      'b.markdown': '# Article B\n\nBody B.',
      'notes/readme.txt': 'ignore me',
      '.DS_Store': 'ignore me too',
    });

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.summary).toEqual({ total: 2, created: 2, failed: 0 });
    const titles = result.results.filter((r) => r.status === 'created').map((r) => r.title);
    expect(titles.sort()).toEqual(['Article A', 'Article B']);

    const { rows } = await ownerPool.query(`select state from article where workspace_id = $1`, [
      workspaceId,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: { state: string }) => r.state === 'draft')).toBe(true);
  });

  it('reports a per-file error for an empty markdown entry without blocking the rest', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, {
      'good.md': '# Good\n\nContent.',
      'empty.md': '   ',
    });

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.summary).toEqual({ total: 2, created: 1, failed: 1 });
    const failed = result.results.find((r) => r.status === 'error');
    expect(failed?.filename).toBe('empty.md');
  });

  it('rejects a zip with no markdown entries', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, { 'readme.txt': 'no md here' });

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result).toEqual({ ok: false, reason: 'no_markdown_files' });
  });

  it('rejects a batch over the file-count cap without creating anything', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const files: Record<string, string> = {};
    for (let i = 0; i < 201; i++) {
      files[`file-${i}.md`] = `# File ${i}\n\nBody.`;
    }
    const key = await uploadFixtureZip(workspaceId, agentId, files);

    const result = await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    expect(result).toEqual({ ok: false, reason: 'too_many_files' });
    const { rows } = await ownerPool.query(
      `select count(*)::int from article where workspace_id = $1`,
      [workspaceId],
    );
    expect(rows[0].count).toBe(0);
  });

  it('rejects a key not owned by this agent', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const result = await bulkImportArticles(
      { agentId, workspaceId, isAdmin: false },
      `pending/${workspaceId}/someone-else/${randomUUID()}.zip`,
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('deletes the pending zip object after processing', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId } = await seedAgent(workspaceId);
    const key = await uploadFixtureZip(workspaceId, agentId, { 'a.md': '# A\n\nBody.' });

    await bulkImportArticles({ agentId, workspaceId, isAdmin: false }, key);

    const meta = await headObject(key);
    expect(meta).toBeNull();
  });
});
```

Add `import { headObject } from '../src/shared/storage/presign.ts';` to the test file's imports for the last case.

- [ ] **Step 4: Run the tests to verify they fail**

```bash
cd backend && pnpm vitest run tests/agent.articles.bulkImport.test.ts
```

Expected: FAIL — `bulkImportArticles` is not exported yet.

- [ ] **Step 5: Implement `bulkImportArticles` in `articlesService.ts`**

Add these imports near the top of `backend/src/agent/services/articlesService.ts`:

```typescript
import JSZip from 'jszip';
import { parseMarkdownEntry, MAX_IMPORT_FILES } from './articleMarkdownImport.ts';
```

And extend the existing storage import line:

```typescript
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  copyObject,
  deleteObject,
  getObjectBuffer,
  headObject,
  presignGetObject,
} from '../../shared/storage/presign.ts';
```

Add the function (near `createArticle`):

```typescript
export type BulkImportArticlesResult =
  | {
      ok: true;
      results: import('@support/types').BulkImportArticleResult[];
      summary: { total: number; created: number; failed: number };
    }
  | { ok: false; reason: 'not_found' | 'invalid_zip' | 'no_markdown_files' | 'too_many_files' };

/**
 * Best-effort, one createArticle() transaction per entry — a bad file must
 * never roll back the good ones in the same batch. The pending zip is deleted
 * after it's read regardless of outcome; it is never needed again.
 */
export async function bulkImportArticles(
  ctx: AgentContext,
  key: string,
): Promise<BulkImportArticlesResult> {
  const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
  if (!key.startsWith(expectedPrefix)) return { ok: false, reason: 'not_found' };

  const meta = await headObject(key);
  if (!meta) return { ok: false, reason: 'not_found' };

  const buffer = await getObjectBuffer(key);
  await deleteObject(key);

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { ok: false, reason: 'invalid_zip' };
  }

  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && /\.(md|markdown)$/i.test(f.name),
  );
  if (entries.length === 0) return { ok: false, reason: 'no_markdown_files' };
  if (entries.length > MAX_IMPORT_FILES) return { ok: false, reason: 'too_many_files' };

  const results: import('@support/types').BulkImportArticleResult[] = [];
  for (const entry of entries) {
    const filename = entry.name.split('/').pop()!;
    try {
      const content = await entry.async('string');
      const parsed = parseMarkdownEntry(content, filename);
      if (parsed.error !== null) {
        results.push({ filename, status: 'error', reason: parsed.error });
        continue;
      }
      const created = await createArticle(ctx, {
        title: parsed.title,
        body: parsed.body,
        keywords: parsed.keywords,
      });
      if (!created.ok) {
        results.push({ filename, status: 'error', reason: created.reason });
        continue;
      }
      results.push({
        filename,
        status: 'created',
        title: parsed.title,
        article_id: created.article.id,
      });
    } catch {
      results.push({ filename, status: 'error', reason: 'unreadable_entry' });
    }
  }

  const created = results.filter((r) => r.status === 'created').length;
  return {
    ok: true,
    results,
    summary: { total: results.length, created, failed: results.length - created },
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd backend && pnpm vitest run tests/agent.articles.bulkImport.test.ts
```

Expected: PASS, all 6 cases.

- [ ] **Step 7: Run the full backend suite for regressions**

```bash
cd backend && pnpm test
```

Expected: PASS (requires Postgres/MinIO up per this repo's test setup — see `README.md` if it isn't).

- [ ] **Step 8: Commit**

```bash
git add backend/package.json backend/pnpm-lock.yaml backend/src/agent/services/articlesService.ts backend/src/errors.ts backend/tests/agent.articles.bulkImport.test.ts
git commit -m "Add bulkImportArticles service: unzip, parse, create drafts best-effort"
```

---

### Task 5: Route, controller, and OpenAPI registration

**Files:**

- Modify: `backend/src/agent/controllers/articlesController.ts`
- Modify: `backend/src/agent/routers/articlesRouter.ts`
- Modify: `backend/src/docs/openapi.ts`
- Modify: `backend/tests/agent.articles.bulkImport.test.ts` (add HTTP-level tests)

**Interfaces:**

- Consumes: `bulkImportArticles` (Task 4), `BulkImportArticlesBody` (Task 3), `requireTeamLeadOrAdmin` (existing, `backend/src/shared/middleware/requireTeamLeadOrAdmin.ts`).

- [ ] **Step 1: Write the failing HTTP-level tests**

Append to `backend/tests/agent.articles.bulkImport.test.ts` (this file already has the full `app`/`request` setup copied from `agent.articles.test.ts` in Task 4 — reuse it):

```typescript
describe('POST /agent/articles/bulk-import', () => {
  it('imports over HTTP as a team lead', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'team_lead');
    const key = await uploadFixtureZip(workspaceId, agentId, {
      'a.md': '# Article A\n\nBody A.',
    });

    const res = await request(app)
      .post('/articles/bulk-import')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key })
      .expect(200);

    expect(res.body.summary).toEqual({ total: 1, created: 1, failed: 0 });
    expect(res.body.results[0]).toMatchObject({ filename: 'a.md', status: 'created' });
  });

  it('403s for a plain agent (not team lead or admin)', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'agent');
    const key = await uploadFixtureZip(workspaceId, agentId, { 'a.md': '# A\n\nBody.' });

    await request(app)
      .post('/articles/bulk-import')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key })
      .expect(403);
  });

  it('400s with no_markdown_files for a zip with no markdown', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgent(workspaceId, 'team_lead');
    const key = await uploadFixtureZip(workspaceId, agentId, { 'readme.txt': 'no md' });

    const res = await request(app)
      .post('/articles/bulk-import')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({ key })
      .expect(400);
    expect(res.body.error.code).toBe('no_markdown_files');
  });

  it('422s when key is missing', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgent(workspaceId, 'team_lead');

    const res = await request(app)
      .post('/articles/bulk-import')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Workspace-Id', workspaceId)
      .send({})
      .expect(422);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
```

Check `seedAgent`'s signature in `backend/tests/helpers/db.ts` to confirm it accepts a role string as its second argument (already used this way in `agent.articles.test.ts`, e.g. `seedAgent(workspaceId, 'team_lead')`) — if the default role (no second arg) is not `'agent'`, adjust the 403 test's role argument to whatever the plain non-privileged role is called.

- [ ] **Step 2: Run to verify failure**

```bash
cd backend && pnpm vitest run tests/agent.articles.bulkImport.test.ts
```

Expected: FAIL — route doesn't exist (404s instead of the expected statuses).

- [ ] **Step 3: Add the controller handler**

In `backend/src/agent/controllers/articlesController.ts`, add to the imports:

```typescript
import { BulkImportArticlesBody } from '@support/types';
import { bulkImportArticles } from '../services/articlesService.ts';
```

(Add `bulkImportArticles` to the existing `from '../services/articlesService.ts'` import block rather than a second import line.)

Add the handler:

```typescript
export const bulkImportArticlesHandler: RequestHandler = async (req, res) => {
  const body = BulkImportArticlesBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'key is required.');
    return;
  }
  const result = await bulkImportArticles(req.agent!, body.data.key);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(res, 404, 'not_found', 'Upload not found.');
      return;
    }
    if (result.reason === 'invalid_zip') {
      sendError(res, 400, 'invalid_zip', 'That file is not a valid zip archive.');
      return;
    }
    if (result.reason === 'no_markdown_files') {
      sendError(res, 400, 'no_markdown_files', 'The zip has no .md or .markdown files in it.');
      return;
    }
    sendError(
      res,
      400,
      'too_many_files',
      'The zip has more than 200 markdown files — split it into smaller batches.',
    );
    return;
  }
  res.status(200).json({ results: result.results, summary: result.summary });
};
```

- [ ] **Step 4: Register the route**

In `backend/src/agent/routers/articlesRouter.ts`, add `bulkImportArticlesHandler` to the imports from `'../controllers/articlesController.ts'`, and add the route (placed with the other `requireTeamLeadOrAdmin`-guarded routes):

```typescript
articlesRouter.post('/articles/bulk-import', requireTeamLeadOrAdmin, bulkImportArticlesHandler);
```

- [ ] **Step 5: Register the OpenAPI path**

In `backend/src/docs/openapi.ts`, near the existing `POST /agent/articles` registration, add:

```typescript
registry.registerPath({
  method: 'post',
  path: '/agent/articles/bulk-import',
  summary: 'Agent Bulk Import Articles',
  description:
    'Reads .md/.markdown files out of an uploaded zip and creates one draft article per file. Team Lead/Admin only.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ key: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: { description: 'Per-file import results' },
    400: { description: 'invalid_zip | no_markdown_files | too_many_files' },
    403: { description: 'Caller is not Team Lead or Admin' },
    404: { description: 'Upload key not found' },
  },
});
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd backend && pnpm vitest run tests/agent.articles.bulkImport.test.ts
```

Expected: PASS, all 10 cases (6 from Task 4 + 4 from this task).

- [ ] **Step 7: Run the full backend suite and typecheck**

```bash
cd backend && pnpm test && cd .. && pnpm typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/agent/controllers/articlesController.ts backend/src/agent/routers/articlesRouter.ts backend/src/docs/openapi.ts backend/tests/agent.articles.bulkImport.test.ts
git commit -m "Add POST /agent/articles/bulk-import route, controller, and OpenAPI doc"
```

---

### Task 6: Frontend API client for bulk import

**Files:**

- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`

**Interfaces:**

- Produces (used by Task 7): `bulkImportArticles(token: string, input: { key: string }): Promise<BulkImportArticlesResponse>`; `putFileToUploadUrl(uploadUrl: string, file: File, onProgress?: (percent: number) => void, contentTypeOverride?: string): Promise<void>` (extended signature, backward compatible).

The existing `putFileToUploadUrl` always signs the PUT's `Content-Type` header from `file.type` — but a `.zip` file's browser-reported MIME type is inconsistent (`application/zip`, `application/x-zip-compressed`, or empty depending on OS/browser), and it must exactly match the `content_type` used to presign the URL or S3 rejects the PUT. This task adds an optional override so the bulk-import caller can force `'application/zip'` deterministically, while every existing caller (image uploads) is unaffected since they don't pass the new parameter.

- [ ] **Step 1: Extend `putFileToUploadUrl` with an optional content-type override**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, change the signature and the one line inside that sets the header:

```typescript
export function putFileToUploadUrl(
  uploadUrl: string,
  file: File,
  onProgress?: (percent: number) => void,
  contentTypeOverride?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentTypeOverride ?? file.type);
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(100);
        resolve();
      } else {
        reject(new Error(`Upload failed with ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.send(file);
  });
}
```

- [ ] **Step 2: Add the `bulkImportArticles` API function**

Add near `createArticle` in the same file:

```typescript
import type { BulkImportArticlesResponse } from '@support/types';

export function bulkImportArticles(
  token: string,
  input: { key: string },
): Promise<BulkImportArticlesResponse> {
  return call('/agent/articles/bulk-import', token, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
```

(If `@support/types` is already imported at the top of the file, add `BulkImportArticlesResponse` to that existing import instead of a new line.)

- [ ] **Step 3: Typecheck**

```bash
cd frontend && pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Check existing callers of `putFileToUploadUrl` still compile with the new optional param**

```bash
grep -rn "putFileToUploadUrl(" frontend/src --include="*.tsx" --include="*.ts"
```

Confirm every call site still passes at most 3 arguments (uploadUrl, file, onProgress) — the new 4th param is optional so this should be unaffected, but verify no call site accidentally breaks.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/api/agentApi.ts
git commit -m "Add bulkImportArticles API client and content-type override for zip uploads"
```

---

### Task 7: BulkImportDialog component

**Files:**

- Create: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.tsx`
- Test: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.test.tsx`

**Interfaces:**

- Consumes: `requestUpload`, `putFileToUploadUrl`, `bulkImportArticles` (Task 6), `Dialog`/`DialogContent`/`DialogHeader`/`DialogTitle`/`DialogFooter` from `../../../components/ui/dialog.tsx`, `Button` from `../../../components/ui/button.tsx`.
- Produces (used by Task 8): `<BulkImportDialog open={boolean} onOpenChange={(open: boolean) => void} token={string} onImported={(response: BulkImportArticlesResponse) => void} />`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.test.tsx`, matching this repo's existing frontend test style (check `ArticleEditorSheet.test.tsx` for the exact `render`/`vi.mock` conventions used for API calls in this surface, and mirror them):

```typescript
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BulkImportDialog } from './BulkImportDialog.tsx';
import * as api from '../../../api/agentApi.ts';

vi.mock('../../../api/agentApi.ts');

function makeZipFile(name = 'articles.zip', sizeBytes = 1024): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'application/zip' });
}

describe('BulkImportDialog', () => {
  beforeEach(() => {
    vi.mocked(api.requestUpload).mockResolvedValue({
      key: 'pending/w/a/x.zip',
      upload_url: 'https://example.test/upload',
      expires_at: new Date().toISOString(),
    });
    vi.mocked(api.putFileToUploadUrl).mockResolvedValue(undefined);
  });

  it('rejects a file over the 20MB client-side cap without calling the API', async () => {
    const onImported = vi.fn();
    render(
      <BulkImportDialog open token="t" onOpenChange={() => {}} onImported={onImported} />,
    );
    const input = screen.getByLabelText(/choose.*zip/i);
    const tooBig = makeZipFile('big.zip', 21 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [tooBig] } });

    await waitFor(() => expect(screen.getByText(/20MB/i)).toBeInTheDocument());
    expect(api.requestUpload).not.toHaveBeenCalled();
  });

  it('uploads, imports, and shows per-file results on success', async () => {
    vi.mocked(api.bulkImportArticles).mockResolvedValue({
      results: [
        { filename: 'a.md', status: 'created', title: 'Article A', article_id: '1' },
        { filename: 'b.md', status: 'error', reason: 'empty_file' },
      ],
      summary: { total: 2, created: 1, failed: 1 },
    });
    const onImported = vi.fn();
    render(
      <BulkImportDialog open token="t" onOpenChange={() => {}} onImported={onImported} />,
    );
    const input = screen.getByLabelText(/choose.*zip/i);
    fireEvent.change(input, { target: { files: [makeZipFile()] } });

    await waitFor(() => expect(screen.getByText(/1 of 2 imported/i)).toBeInTheDocument());
    expect(screen.getByText('Article A')).toBeInTheDocument();
    expect(screen.getByText(/empty_file/i)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledWith(
      expect.objectContaining({ summary: { total: 2, created: 1, failed: 1 } }),
    );
  });

  it('shows an error state if the import call rejects', async () => {
    vi.mocked(api.bulkImportArticles).mockRejectedValue(new Error('boom'));
    render(<BulkImportDialog open token="t" onOpenChange={() => {}} onImported={() => {}} />);
    const input = screen.getByLabelText(/choose.*zip/i);
    fireEvent.change(input, { target: { files: [makeZipFile()] } });

    await waitFor(() => expect(screen.getByText(/could not import/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.test.tsx
```

Expected: FAIL — the component doesn't exist yet.

- [ ] **Step 3: Implement `BulkImportDialog.tsx`**

```typescript
import { useRef, useState } from 'react';
import type { BulkImportArticlesResponse } from '@support/types';
import { bulkImportArticles, putFileToUploadUrl, requestUpload } from '../../../api/agentApi.ts';
import { Button } from '../../../components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog.tsx';

const MAX_ZIP_BYTES = 20 * 1024 * 1024;

type Stage = 'idle' | 'uploading' | 'importing' | 'done' | 'error';

export function BulkImportDialog({
  open,
  onOpenChange,
  token,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  onImported: (response: BulkImportArticlesResponse) => void;
}) {
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [results, setResults] = useState<BulkImportArticlesResponse | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStage('idle');
    setProgress(0);
    setErrorMessage(null);
    setResults(null);
  }

  async function handleFile(file: File) {
    setErrorMessage(null);
    setResults(null);
    if (file.size > MAX_ZIP_BYTES) {
      setErrorMessage('That file exceeds the 20MB limit.');
      return;
    }
    try {
      setStage('uploading');
      setProgress(0);
      const uploaded = await requestUpload(token, {
        filename: file.name,
        contentType: 'application/zip',
        byteSize: file.size,
      });
      await putFileToUploadUrl(uploaded.upload_url, file, setProgress, 'application/zip');
      setStage('importing');
      const response = await bulkImportArticles(token, { key: uploaded.key });
      setResults(response);
      setStage('done');
      onImported(response);
    } catch {
      setErrorMessage('Could not import that zip. Please try again.');
      setStage('error');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk import from zip</DialogTitle>
        </DialogHeader>

        {(stage === 'idle' || stage === 'error') && (
          <div className="flex flex-col gap-3">
            <label htmlFor="bulk-import-zip-input" className="text-sm text-muted">
              Choose a .zip of markdown files to import
            </label>
            <input
              id="bulk-import-zip-input"
              ref={inputRef}
              type="file"
              accept=".zip"
              aria-label="Choose a zip file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void handleFile(file);
              }}
            />
            {errorMessage && <p className="text-sm text-red-600">{errorMessage}</p>}
          </div>
        )}

        {stage === 'uploading' && (
          <p className="text-sm text-muted">Uploading… {progress}%</p>
        )}

        {stage === 'importing' && <p className="text-sm text-muted">Importing articles…</p>}

        {stage === 'done' && results && (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium">
              {results.summary.created} of {results.summary.total} imported
            </p>
            <ul className="max-h-64 overflow-y-auto text-sm">
              {results.results.map((r) => (
                <li key={r.filename} className="flex items-center justify-between gap-2 py-1">
                  <span className="truncate">{r.filename}</span>
                  {r.status === 'created' ? (
                    <span className="text-green-700">{r.title}</span>
                  ) : (
                    <span className="text-red-600">{r.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd frontend && pnpm vitest run src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.test.tsx
```

Expected: PASS, all 3 cases. If the `Dialog` component from `ui/dialog.tsx` doesn't render its content without extra required props (check its actual signature if this fails), adjust the props passed above to match — don't guess further blind, read `frontend/src/surfaces/agent-console/components/ui/dialog.tsx` if step 4 fails on a missing-prop error.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.tsx frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/BulkImportDialog.test.tsx
git commit -m "Add BulkImportDialog for zip-based article import"
```

---

### Task 8: Wire the "Bulk Import" button into the KnowledgeBase list

**Files:**

- Modify: `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleTable.tsx`

**Interfaces:**

- Consumes: `BulkImportDialog` (Task 7), `canBuildForms` from `../../../lib/agentSession.ts` (existing — already used in `ArticleEditorSheet.tsx` to gate publish/archive; reused here for the same Team-Lead/Admin boundary), `useQueryClient` from `@tanstack/react-query`.

- [ ] **Step 1: Modify `ArticleTable.tsx`**

Add imports:

```typescript
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { canBuildForms, loadAgentSession } from '../../../lib/agentSession.ts';
import { BulkImportDialog } from './BulkImportDialog.tsx';
```

Inside the `ArticleTable` component, add state and the button, and invalidate the article list query when the dialog reports any successful import:

```typescript
export function ArticleTable({
  token,
  selectedId,
  onSelect,
  onNew,
}: {
  token: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const queryClient = useQueryClient();
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const session = loadAgentSession();
  const articles = useQuery({ queryKey: ['admin-articles'], queryFn: () => fetchArticles(token) });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 p-3">
        <span className="text-sm font-semibold">Articles</span>
        <div className="flex items-center gap-2">
          {canBuildForms(session) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setBulkImportOpen(true)}
            >
              Bulk Import
            </Button>
          )}
          <Button type="button" size="sm" onClick={onNew}>
            + New
          </Button>
        </div>
      </div>
      {/* ...existing table body unchanged... */}
      <BulkImportDialog
        open={bulkImportOpen}
        onOpenChange={setBulkImportOpen}
        token={token}
        onImported={(response) => {
          if (response.summary.created > 0) {
            void queryClient.invalidateQueries({ queryKey: ['admin-articles'] });
          }
        }}
      />
    </div>
  );
}
```

(Leave the existing table/`EmptyState` JSX between the header `div` and the new `<BulkImportDialog />` exactly as it is — only the header `div` and the addition after the scrollable table container change.)

- [ ] **Step 2: Manually verify in the browser**

```bash
pnpm dev
```

Navigate to the agent console KnowledgeBase page as a Team Lead or Admin account. Confirm:

- "Bulk Import" button is visible next to "+ New" for a Team Lead/Admin session, and hidden for a plain agent session.
- Selecting a `.zip` with a few `.md` files shows the uploading → importing → results sequence, and the new drafts appear in the list after closing the dialog.
- Selecting a zip over 20MB shows the client-side size error without any network call (check the Network tab).

- [ ] **Step 3: Run the frontend test suite for regressions**

```bash
cd frontend && pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ArticleTable.tsx
git commit -m "Add Bulk Import button to KnowledgeBase article list, gated to Team Lead/Admin"
```

---

## Final verification

- [ ] Run `pnpm typecheck` from the repo root — expect no errors.
- [ ] Run `pnpm test` from the repo root — expect all packages' suites to pass (Postgres/MinIO must be up per `README.md`).
- [ ] Confirm `http://localhost:4000/docs` shows the new `POST /agent/articles/bulk-import` endpoint.
