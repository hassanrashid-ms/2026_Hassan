# MinIO Storage + Agent-Chat Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up MinIO as the object store, add presigned-URL upload/claim/cancel endpoints for image attachments, and wire image attachments into the agent-console chat composer end to end.

**Architecture:** A backend "storage" choke point (`s3Client.ts` + `presign.ts`) wraps `@aws-sdk/client-s3`, used by a new `uploadsRouter` (presign PUT, cancel) and an extension to the existing message-send path (claim: HEAD-verify → CopyObject → transactional insert of `message` + new `attachment` row). Reads sign a fresh, short-lived GET URL per message at serialization time. The frontend's shared `Composer`/`MessageBody` components (used by both surfaces) gain attachment support behind a new prop, wired into the agent console only in this phase.

**Tech Stack:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, MinIO (docker-compose), Drizzle ORM, Express 5, Zod, React, TanStack Query.

**Spec:** `docs/specs/2026-08-24-minio-attachments-agent-chat-design.md`

## Global Constraints

- Images only: `image/png`, `image/jpeg`, `image/webp`, `image/gif`.
- Max size 10 MB (`10 * 1024 * 1024` bytes), enforced both at presign time and re-verified at claim time.
- Presigned PUT TTL: 5 minutes. Presigned GET TTL: 10 minutes, re-signed on every read, never persisted.
- Object keys are server-generated UUIDs, never client-supplied filenames.
- `message.body` defaults to the attachment's original filename when the send has no typed text (never an empty body — `postMessage` throws on empty).
- No `attachment` row is ever written until the owning `message` row commits in the same transaction.
- All new/changed routes are registered in `backend/src/docs/openapi.ts`.
- Follow existing repo conventions exactly: RLS is structural (no manual per-table policy — just add `workspace_id` to the new table and re-run `db:setup`), `404` not `403` for "not yours", `sendError(res, status, code, message)` for error responses, `logger` (never `console.*`).

---

### Task 1: MinIO infrastructure, env vars, and the storage choke point

**Files:**
- Modify: `docker-compose.yml`
- Modify: `backend/src/env.ts`
- Modify: `.env.example`, `.env.test.example`, `.env`, `.env.test` (local, untracked — see step 6)
- Modify: `backend/package.json`
- Create: `backend/src/shared/storage/s3Client.ts`
- Create: `backend/src/shared/storage/presign.ts`
- Create: `backend/scripts/setup-minio-bucket.ts`
- Test: `backend/tests/storage.presign.test.ts`

**Interfaces:**
- Produces (used by every later task):
  - `getS3Client(): S3Client` — `backend/src/shared/storage/s3Client.ts`
  - `presignPutObject(input: { key: string; contentType: string; contentLength: number }): Promise<{ url: string; expiresAt: string }>` — `backend/src/shared/storage/presign.ts`
  - `presignGetObject(input: { key: string }): Promise<string>` — same file
  - `headObject(key: string): Promise<{ contentType: string; contentLength: number } | null>` — same file, returns `null` (not throw) when the object doesn't exist
  - `copyObject(input: { sourceKey: string; destKey: string }): Promise<void>` — same file
  - `deleteObject(key: string): Promise<void>` — same file, resolves even if the object is already gone
  - `ALLOWED_IMAGE_MIME_TYPES: readonly string[]` and `MAX_ATTACHMENT_BYTES: number` — exported from `presign.ts`

- [ ] **Step 1: Add the AWS SDK dependencies**

```bash
cd backend && pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3
```

- [ ] **Step 2: Add the MinIO service to `docker-compose.yml`**

Add this service to the existing `services:` block (alongside `postgres` and `redis`), and the volume to the existing `volumes:` block:

```yaml
  minio:
    image: minio/minio
    container_name: support-minio
    environment:
      MINIO_ROOT_USER: support_minio
      MINIO_ROOT_PASSWORD: support_minio_password
    ports: ['9000:9000', '9001:9001']
    command: ['server', '/data', '--console-address', ':9001']
    volumes: ['support-miniodata:/data']
    healthcheck:
      test: ['CMD', 'curl', '-f', 'http://localhost:9000/minio/health/live']
      interval: 5s
      timeout: 3s
      retries: 20
```

```yaml
volumes:
  support-pgdata:
  support-redisdata:
  support-miniodata:
```

- [ ] **Step 3: Add env vars to `backend/src/env.ts`**

In `EnvSchema`, after `SURFACE_ORIGINS`:

```ts
  S3_ENDPOINT: z.string().min(1, 'S3_ENDPOINT is required').default('http://localhost:9000'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1, 'S3_ACCESS_KEY_ID is required'),
  S3_SECRET_ACCESS_KEY: z.string().min(1, 'S3_SECRET_ACCESS_KEY is required'),
  S3_BUCKET: z.string().min(1).default('support-attachments'),
```

- [ ] **Step 4: Create the storage client module**

`backend/src/shared/storage/s3Client.ts`:

```ts
import { S3Client } from '@aws-sdk/client-s3';
import { getEnv } from '../../env.ts';

let cached: S3Client | undefined;

/**
 * Single S3Client instance, memoised the same way getEnv() is. MinIO requires
 * path-style addressing (forcePathStyle: true) — virtual-hosted-style bucket
 * URLs don't resolve against a self-hosted endpoint the way they do against AWS.
 */
export function getS3Client(): S3Client {
  if (cached) return cached;
  const env = getEnv();
  cached = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  return cached;
}

/** Tests only — forces the next getS3Client() to build a fresh client. */
export function resetS3ClientCache(): void {
  cached = undefined;
}
```

- [ ] **Step 5: Create the presign/storage-operations module**

`backend/src/shared/storage/presign.ts`:

```ts
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../../env.ts';
import { getS3Client } from './s3Client.ts';

export const ALLOWED_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const PUT_TTL_SECONDS = 5 * 60;
const GET_TTL_SECONDS = 10 * 60;

/**
 * Signs a PUT with ContentType and ContentLength as part of the signed request.
 * A client that sends different header values gets a signature mismatch from
 * MinIO/S3 directly — this is what enforces "only this exact declared type and
 * size may be uploaded to this key", with no separate POST-policy needed.
 */
export async function presignPutObject(input: {
  key: string;
  contentType: string;
  contentLength: number;
}): Promise<{ url: string; expiresAt: string }> {
  const env = getEnv();
  const command = new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
    ContentLength: input.contentLength,
  });
  const url = await getSignedUrl(getS3Client(), command, { expiresIn: PUT_TTL_SECONDS });
  const expiresAt = new Date(Date.now() + PUT_TTL_SECONDS * 1000).toISOString();
  return { url, expiresAt };
}

/** Fresh every call, never cached — a stored GET URL would eventually 403/expire silently. */
export async function presignGetObject(key: string): Promise<string> {
  const env = getEnv();
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(getS3Client(), command, { expiresIn: GET_TTL_SECONDS });
}

/**
 * Null, not a throw, when the object is missing — the caller (claim, or the
 * read-side signer) treats "gone" as an ordinary case to handle, not a fault.
 */
export async function headObject(
  key: string,
): Promise<{ contentType: string; contentLength: number } | null> {
  const env = getEnv();
  try {
    const result = await getS3Client().send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    );
    return {
      contentType: result.ContentType ?? '',
      contentLength: result.ContentLength ?? 0,
    };
  } catch (error) {
    if (error instanceof NotFound) return null;
    throw error;
  }
}

export async function copyObject(input: { sourceKey: string; destKey: string }): Promise<void> {
  const env = getEnv();
  await getS3Client().send(
    new CopyObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: input.destKey,
      CopySource: `${env.S3_BUCKET}/${input.sourceKey}`,
    }),
  );
}

/** Resolves even if the object is already gone — cancel/cleanup must be idempotent. */
export async function deleteObject(key: string): Promise<void> {
  const env = getEnv();
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
  }
}
```

- [ ] **Step 6: Add local env values and the bucket-setup script**

Append to `.env.example` (after `SURFACE_ORIGINS`):

```
# MinIO (S3-compatible). Bucket is created and made private by `pnpm minio:setup`.
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=support_minio
S3_SECRET_ACCESS_KEY=support_minio_password
S3_BUCKET=support-attachments
```

Append the same block to `.env.test.example`, `.env`, and `.env.test` (your local, untracked copies) with `S3_BUCKET=support-attachments-test` in the two test files, so test runs never touch the dev bucket.

`backend/scripts/setup-minio-bucket.ts` (mirrors `setup-weaviate-collection.ts`'s structure):

```ts
export {};

// One-off script: creates the attachments bucket if absent and applies a
// private policy (no public-read, no anonymous listing) plus CORS scoped to
// SURFACE_ORIGINS. Never invoked at app boot — run manually or from a setup
// step alongside `pnpm db:setup`.
//
//   cd backend && node --experimental-strip-types scripts/setup-minio-bucket.ts
const { loadRootEnv } = await import('../src/env/loadRootEnv.ts');
loadRootEnv(import.meta.url);

import { CreateBucketCommand, HeadBucketCommand, NotFound, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { getEnv } from '../src/env.ts';
import { getS3Client } from '../src/shared/storage/s3Client.ts';

async function main() {
  const env = getEnv();
  const client = getS3Client();

  const exists = await client
    .send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
    .then(() => true)
    .catch((error) => {
      if (error instanceof NotFound) return false;
      throw error;
    });

  if (!exists) {
    console.log(`Creating bucket "${env.S3_BUCKET}"...`);
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  } else {
    console.log(`Bucket "${env.S3_BUCKET}" already exists.`);
  }

  await client.send(
    new PutBucketCorsCommand({
      Bucket: env.S3_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: env.SURFACE_ORIGINS,
            AllowedMethods: ['PUT', 'GET'],
            AllowedHeaders: ['*'],
            MaxAgeSeconds: 3000,
          },
        ],
      },
    }),
  );
  console.log('CORS applied. Bucket has no public-read policy by default — nothing further needed.');
}

await main();
```

Add to `backend/package.json`'s `scripts`:

```json
    "minio:setup": "node --experimental-strip-types scripts/setup-minio-bucket.ts"
```

- [ ] **Step 7: Start MinIO and run the bucket setup**

```bash
docker compose up -d minio
cd backend && pnpm minio:setup
```

Expected: prints `Creating bucket "support-attachments"...` (first run) and `CORS applied...`.

- [ ] **Step 8: Write a failing test for the presign module**

`backend/tests/storage.presign.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  copyObject,
  deleteObject,
  headObject,
  presignGetObject,
  presignPutObject,
} from '../src/shared/storage/presign.ts';

async function putViaPresignedUrl(url: string, contentType: string, body: Buffer) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType, 'Content-Length': String(body.length) },
    body,
  });
  if (!res.ok) throw new Error(`PUT failed with ${res.status}: ${await res.text()}`);
}

describe('storage/presign', () => {
  it('round-trips an object through presigned PUT, HEAD, copy, and GET', async () => {
    const key = `test/${randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');

    const { url } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: body.length,
    });
    await putViaPresignedUrl(url, 'image/png', body);

    const head = await headObject(key);
    expect(head).toMatchObject({ contentType: 'image/png', contentLength: body.length });

    const destKey = `test/${randomUUID()}.png`;
    await copyObject({ sourceKey: key, destKey });
    expect(await headObject(destKey)).toMatchObject({ contentType: 'image/png' });

    const getUrl = await presignGetObject(destKey);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    expect(await getRes.text()).toBe(body.toString());

    await deleteObject(key);
    await deleteObject(destKey);
  });

  it('headObject returns null for a missing key', async () => {
    expect(await headObject(`test/${randomUUID()}.png`)).toBeNull();
  });

  it('deleteObject resolves even when the object never existed', async () => {
    await expect(deleteObject(`test/${randomUUID()}.png`)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 9: Run the test to verify it fails**

Run: `cd backend && pnpm test tests/storage.presign.test.ts`
Expected: FAIL — `S3_ACCESS_KEY_ID is required` (env not yet set) or a connection error if MinIO isn't running yet. Confirms the module compiles and actually reaches for real credentials/config, not a stub.

- [ ] **Step 10: Make it pass**

Ensure `.env.test` has the S3 vars from Step 6 and MinIO is running (Step 7), then re-run. If the bucket named in `.env.test`'s `S3_BUCKET` doesn't exist yet, run `pnpm minio:setup` with `.env.test` loaded, or add a second bucket manually — simplest is to reuse one bucket name across `.env` and `.env.test` for local dev, since MinIO here is a single shared local instance, not a per-environment service.

Run: `cd backend && pnpm test tests/storage.presign.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 11: Commit**

```bash
git add docker-compose.yml backend/src/env.ts backend/src/shared/storage backend/scripts/setup-minio-bucket.ts backend/package.json backend/tests/storage.presign.test.ts .env.example .env.test.example
git commit -m "Add MinIO service and S3 storage choke point"
```

---

### Task 2: `attachment` table

**Files:**
- Modify: `backend/src/shared/db/schema/conversations.ts`
- Modify: `backend/tests/helpers/db.ts`
- Test: `backend/tests/domain.postMessage.test.ts` (extend, not replace)

**Interfaces:**
- Consumes: nothing new.
- Produces: `attachment` Drizzle table export from `backend/src/shared/db/schema/conversations.ts` (also re-exported from `backend/src/shared/db/schema/index.ts` via its existing `export * from './conversations.ts'`), columns `id, workspaceId, messageId, storageKey, mimeType, byteSize, createdAt`.

- [ ] **Step 1: Add the table to the schema**

In `backend/src/shared/db/schema/conversations.ts`, after the `message` table definition (and its closing `);`), add:

```ts
export const attachment = pgTable('attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspace.id, { onDelete: 'restrict' }),
  /**
   * Exactly one parent, deliberately not polymorphic — see
   * docs/specs/2026-08-24-minio-attachments-agent-chat-design.md §4. No row
   * exists until the owning message sends: an abandoned upload is bytes in
   * `pending/`, never a row here.
   */
  messageId: uuid('message_id')
    .notNull()
    .references(() => message.id, { onDelete: 'restrict' }),
  /** `ws/{workspaceId}/attachments/{uuid}.{ext}` once claimed. Never a URL — reads sign this fresh. */
  storageKey: text('storage_key').notNull(),
  /** Verified via HEAD at claim time, never the client-declared value. */
  mimeType: text('mime_type').notNull(),
  /** Verified via HEAD at claim time, never the client-declared value. */
  byteSize: integer('byte_size').notNull(),
  createdAt: timestamp('created_at', tz).notNull().defaultNow(),
});
```

(The file already imports `pgTable`, `text`, `timestamp`, `uuid`, `integer` — confirm `integer` is imported; if not, add it to the existing `drizzle-orm/pg-core` import line.)

- [ ] **Step 2: Generate the migration**

```bash
cd backend && pnpm db:generate
```

Expected: a new file appears under `backend/drizzle/`, e.g. `00xx_<generated-name>.sql`, containing a `CREATE TABLE "attachment" (...)`. Open it and confirm it matches the columns above with the two FKs as `ON DELETE RESTRICT`.

- [ ] **Step 3: Apply it and re-run RLS**

```bash
pnpm db:setup
```

Expected: exits 0. `attachment` now has RLS enabled and forced (picked up automatically by `002_rls.sql`'s structural loop — no manual edit needed there).

- [ ] **Step 4: Add `attachment` to the test-truncation table list**

In `backend/tests/helpers/db.ts`, add `'attachment'` to `SCOPED_TABLES`, positioned before `'message'` (it has a FK to `message`, so it must truncate first when using `CASCADE`... actually `truncate ... cascade` handles ordering automatically, but keep the list's existing convention of listing dependents before their parents):

```ts
const SCOPED_TABLES = [
  'attachment',
  'resolution_cycle',
  'form_answer',
  // ...unchanged rest
```

- [ ] **Step 5: Write a failing test proving the table's constraints**

Add to `backend/tests/domain.postMessage.test.ts` (open the file first to match its existing `describe`/import style; this new `describe` block can be appended at the end):

```ts
describe('attachment table', () => {
  it('rejects an attachment row with no matching message', async () => {
    const workspaceId = await seedWorkspace();
    await expect(
      ownerPool.query(
        `insert into attachment (workspace_id, message_id, storage_key, mime_type, byte_size)
         values ($1, $2, 'ws/x/attachments/y.png', 'image/png', 10)`,
        [workspaceId, randomUUID()],
      ),
    ).rejects.toThrow();
  });
});
```

(Import `randomUUID` from `node:crypto` and `ownerPool`/`seedWorkspace` from `./helpers/db.ts` if not already imported in this file.)

- [ ] **Step 6: Run it to verify it currently fails for the wrong reason, then passes**

Run: `cd backend && pnpm test tests/domain.postMessage.test.ts`
Expected: PASS — the FK constraint added in Step 1-3 is what makes the insert reject; this step is verifying the migration actually applied, not adding new application code.

- [ ] **Step 7: Commit**

```bash
git add backend/src/shared/db/schema/conversations.ts backend/drizzle backend/tests/helpers/db.ts backend/tests/domain.postMessage.test.ts
git commit -m "Add attachment table, parented to message"
```

---

### Task 3: `POST /agent/uploads` and `DELETE /agent/uploads/:key`

**Files:**
- Create: `backend/src/agent/routers/uploadsRouter.ts`
- Create: `backend/src/agent/controllers/uploadsController.ts`
- Create: `backend/src/agent/services/uploadsService.ts`
- Modify: `backend/src/agent/router.ts` (mount the new router)
- Modify: `backend/src/errors.ts` (new `ErrorCode` values)
- Modify: `packages/types/src/chat.ts` (request/response types)
- Test: `backend/tests/agent.uploads.test.ts`

**Interfaces:**
- Consumes: `AgentContext` type from `backend/src/shared/middleware/requireAgentSession.ts` (`{ agentId, workspaceId, isAdmin }`); `sendError` from `backend/src/errors.ts`.
- Produces (used by Task 4 and the frontend Task 7):
  - `RequestUploadBody = z.object({ filename: z.string().min(1).max(255), content_type: z.string(), byte_size: z.number().int().positive() })` — `packages/types/src/chat.ts`
  - `type RequestUploadResponse = { key: string; upload_url: string; expires_at: string }` — same file
  - `buildPendingKey(workspaceId: string, agentId: string, extension: string): string` — `uploadsService.ts`, format `pending/{workspaceId}/{agentId}/{uuid}.{ext}`
  - `requestUpload(ctx: AgentContext, body): Promise<RequestUploadResponse | { outcome: 'invalid_media_type' } | { outcome: 'too_large' }>` — `uploadsService.ts`
  - `cancelUpload(ctx: AgentContext, key: string): Promise<'ok' | 'not_owner'>` — `uploadsService.ts`

- [ ] **Step 1: Add the new error codes**

In `backend/src/errors.ts`, extend the `ErrorCode` union (add after `'not_connected'`):

```ts
  | 'unsupported_media_type'
  | 'attachment_not_found'
  | 'attachment_mismatch'
```

- [ ] **Step 2: Add the wire types**

In `packages/types/src/chat.ts`, add near the other `SendAgentMessageBody`-style exports:

```ts
export const RequestUploadBody = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1),
  byte_size: z.number().int().positive(),
});

export type RequestUploadResponse = {
  key: string;
  upload_url: string;
  expires_at: string;
};
```

- [ ] **Step 3: Write the failing service test**

`backend/tests/agent.uploads.test.ts` (mirrors `agent.messages.test.ts`'s app-under-test setup, but this router needs no Socket.io since neither handler emits):

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requireAgentSession } from '../src/shared/middleware/requireAgentSession.ts';
import { errorMiddleware } from '../src/errors.ts';
import { signAgentSession } from '../src/shared/auth/agentSession.ts';
import { uploadsRouter } from '../src/agent/routers/uploadsRouter.ts';
import { headObject } from '../src/shared/storage/presign.ts';
import { closeOwnerPool, ownerPool, seedWorkspace, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requireAgentSession, uploadsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

async function seedAgentToken(workspaceId: string) {
  const { rows } = await ownerPool.query<{ id: string }>(
    `insert into agent (email, display_name) values ('agent1@example.test', 'Agent One') returning id`,
  );
  const agentId = rows[0]!.id;
  await ownerPool.query(
    `insert into workspace_member (workspace_id, agent_id, role) values ($1, $2, 'agent')`,
    [workspaceId, agentId],
  );
  return { agentId, token: await signAgentSession({ agent_id: agentId, workspace_id: workspaceId }) };
}

describe('POST /agent/uploads', () => {
  it('returns a presigned PUT url for an allowed image type', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentToken(workspaceId);

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'screenshot.png', content_type: 'image/png', byte_size: 1024 })
      .expect(200);

    expect(res.body.key).toContain(`pending/${workspaceId}/${agentId}/`);
    expect(res.body.upload_url).toContain('http');
    expect(res.body.expires_at).toBeTruthy();
  });

  it('422s for a disallowed content type', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentToken(workspaceId);

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'doc.pdf', content_type: 'application/pdf', byte_size: 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });

  it('422s for a byte_size over the cap', async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentToken(workspaceId);

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'big.png', content_type: 'image/png', byte_size: 11 * 1024 * 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('DELETE /agent/uploads/:key', () => {
  it('deletes an object the caller owns', async () => {
    const workspaceId = await seedWorkspace();
    const { agentId, token } = await seedAgentToken(workspaceId);
    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(key)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(await headObject(key)).toBeNull();
  });

  it("404s for a key under a different agent's path", async () => {
    const workspaceId = await seedWorkspace();
    const { token } = await seedAgentToken(workspaceId);
    const otherKey = `pending/${workspaceId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(otherKey)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.uploads.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/routers/uploadsRouter.ts'`.

- [ ] **Step 5: Implement the service**

`backend/src/agent/services/uploadsService.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestUploadBody, RequestUploadResponse } from '@support/types';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  deleteObject,
  presignPutObject,
} from '../../shared/storage/presign.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

function extensionFor(contentType: string): string {
  switch (contentType) {
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

export function buildPendingKey(workspaceId: string, agentId: string, contentType: string): string {
  return `pending/${workspaceId}/${agentId}/${randomUUID()}.${extensionFor(contentType)}`;
}

export type RequestUploadResult =
  | ({ outcome: 'ok' } & RequestUploadResponse)
  | { outcome: 'invalid_media_type' }
  | { outcome: 'too_large' };

export async function requestUpload(
  ctx: AgentContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(body.content_type as (typeof ALLOWED_IMAGE_MIME_TYPES)[number])) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > MAX_ATTACHMENT_BYTES) {
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

/**
 * Ownership is the key's own {agentId} path segment, not a DB lookup — no row
 * exists for a pending upload by design. 'not_owner' maps to 404 at the
 * controller, matching the repo's "404 not 403" convention.
 */
export async function cancelUpload(ctx: AgentContext, key: string): Promise<'ok' | 'not_owner'> {
  const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.agentId}/`;
  if (!key.startsWith(expectedPrefix)) return 'not_owner';
  await deleteObject(key);
  return 'ok';
}
```

- [ ] **Step 6: Implement the controller**

`backend/src/agent/controllers/uploadsController.ts`:

```ts
import type { RequestHandler } from 'express';
import { RequestUploadBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { cancelUpload, requestUpload } from '../services/uploadsService.ts';

export const postUploadRequestHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = RequestUploadBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'filename, content_type and byte_size are required.');
    return;
  }
  if (body.data.byte_size > 10 * 1024 * 1024) {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the 10 MB limit.');
    return;
  }

  const result = await requestUpload(ctx, body.data);
  if (result.outcome === 'invalid_media_type') {
    sendError(res, 422, 'unsupported_media_type', 'Only PNG, JPEG, WEBP and GIF are accepted.');
    return;
  }
  if (result.outcome === 'too_large') {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the 10 MB limit.');
    return;
  }
  res.status(200).json({ key: result.key, upload_url: result.upload_url, expires_at: result.expires_at });
};

export const deleteUploadHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const key = req.params.key!;
  const result = await cancelUpload(ctx, key);
  if (result === 'not_owner') {
    sendError(res, 404, 'not_found', 'Upload not found.');
    return;
  }
  res.status(204).send();
};
```

Note: `byte_size` is checked twice (controller pre-check and service) deliberately — the controller's check gives a clean `invalid_request` before any storage call; the service's is defense-in-depth for any other caller of `requestUpload` that skips the controller's check (there are none today, but the service must not trust its caller either).

- [ ] **Step 7: Wire the router**

`backend/src/agent/routers/uploadsRouter.ts`:

```ts
import { Router } from 'express';
import { deleteUploadHandler, postUploadRequestHandler } from '../controllers/uploadsController.ts';

export const uploadsRouter = Router();
uploadsRouter.post('/uploads', postUploadRequestHandler);
// :key contains slashes (pending/{ws}/{agent}/{uuid}.ext) — Express 5 needs the
// wildcard form to capture the rest of the path in one param.
uploadsRouter.delete('/uploads/{*key}', (req, res, next) => {
  req.params.key = Array.isArray(req.params.key) ? req.params.key.join('/') : req.params.key;
  next();
}, deleteUploadHandler);
```

In `backend/src/agent/router.ts`, add the import and mount it alongside the other routers (after `messagesRouter`):

```ts
import { uploadsRouter } from './routers/uploadsRouter.ts';
// ...
agentRouter.use(uploadsRouter);
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/agent.uploads.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 9: Register both routes in the OpenAPI doc**

In `backend/src/docs/openapi.ts`, near the other `/agent/messages*` registrations, add:

```ts
registry.registerPath({
  method: 'post',
  path: '/agent/uploads',
  summary: 'Agent Request Upload URL',
  description: 'Returns a presigned PUT URL for an image attachment, valid for 5 minutes.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            filename: z.string().min(1).max(255),
            content_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
            byte_size: z.number().int().positive(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Presigned upload URL',
      content: {
        'application/json': {
          schema: z.object({ key: z.string(), upload_url: z.string(), expires_at: z.string() }),
        },
      },
    },
    422: { description: 'Unsupported media type or byte_size over the limit' },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/agent/uploads/{key}',
  summary: 'Agent Cancel Upload',
  description: 'Deletes a pending (not-yet-claimed) uploaded object.',
  security: [{ [bearerAgentJwt.name]: [] }],
  request: { params: z.object({ key: z.string() }) },
  responses: {
    204: { description: 'Deleted (idempotent)' },
    404: { description: 'Key not owned by the caller' },
  },
});
```

- [ ] **Step 10: Commit**

```bash
git add backend/src/agent/routers/uploadsRouter.ts backend/src/agent/controllers/uploadsController.ts backend/src/agent/services/uploadsService.ts backend/src/agent/router.ts backend/src/errors.ts packages/types/src/chat.ts backend/tests/agent.uploads.test.ts backend/src/docs/openapi.ts
git commit -m "Add presigned upload request and cancel endpoints"
```

---

### Task 4: Claim the attachment on `POST /agent/messages`

**Files:**
- Modify: `packages/types/src/chat.ts` (`SendAgentMessageBody`, `AgentMessageView`)
- Modify: `backend/src/agent/services/messagesService.ts`
- Modify: `backend/src/agent/controllers/messagesController.ts`
- Test: `backend/tests/agent.messages.test.ts` (extend)

**Interfaces:**
- Consumes: `headObject`, `copyObject`, `deleteObject`, `ALLOWED_IMAGE_MIME_TYPES`, `MAX_ATTACHMENT_BYTES` from Task 1; `attachment` table from Task 2.
- Produces: `AgentMessageView.attachment?: { id: string; filename: string; mime_type: string; byte_size: number } | null` (URL is added later, in Task 5's read path — this task only inserts the row and returns its non-URL fields on the send response).

- [ ] **Step 1: Extend the wire types**

In `packages/types/src/chat.ts`:

```ts
export const SendAgentMessageBody = z.object({
  conversation_id: z.uuid(),
  body: z.string().min(1).max(4000),
  visibility: z.enum(['public', 'internal']).default('public'),
  attachment: z
    .object({
      key: z.string().min(1),
      filename: z.string().min(1).max(255),
      mime_type: z.string().min(1),
      byte_size: z.number().int().positive(),
    })
    .optional(),
});
```

Change `body: z.string().min(1).max(4000)` to accept an attachment-only send with no typed text — the min-length-1 stays on the wire schema, but the *filename* becomes the body server-side when the caller sends an attachment with an empty/whitespace body. Loosen the schema's `body` to allow empty when `attachment` is present:

```ts
export const SendAgentMessageBody = z
  .object({
    conversation_id: z.uuid(),
    body: z.string().max(4000),
    visibility: z.enum(['public', 'internal']).default('public'),
    attachment: z
      .object({
        key: z.string().min(1),
        filename: z.string().min(1).max(255),
        mime_type: z.string().min(1),
        byte_size: z.number().int().positive(),
      })
      .optional(),
  })
  .refine((v) => v.body.trim().length > 0 || v.attachment !== undefined, {
    message: 'body must be non-empty, or an attachment must be provided',
    path: ['body'],
  });
```

And extend `AgentMessageView`:

```ts
export type AgentMessageView = PlayerMessageView & {
  author_agent_id: string | null;
  visibility: 'public' | 'internal';
  attachment: { id: string; filename: string; mime_type: string; byte_size: number; url: string | null } | null;
};
```

(Also add the same `attachment` field to `PlayerMessageView` as `attachment: ... | null` — it's additive and the frozen-contract rule only forbids removing/retyping fields, never adding one. This keeps `toPlayerView`/`toAgentView` symmetric ahead of the later webview phase, even though this phase only ever populates it from the agent path.)

- [ ] **Step 2: Write the failing test**

Add to `backend/tests/agent.messages.test.ts`, inside a new `describe('POST /agent/messages with an attachment', ...)` block. This needs a real object in MinIO to HEAD/copy, so it uses the same `presignPutObject`/`fetch` round-trip as Task 1's storage test:

```ts
import { presignPutObject } from '../src/shared/storage/presign.ts';

// ...inside the file, alongside the existing describe blocks:

describe('POST /agent/messages with an attachment', () => {
  async function uploadFixtureImage(workspaceId: string, agentId: string) {
    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');
    const { url } = await presignPutObject({ key, contentType: 'image/png', contentLength: body.length });
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
      body,
    });
    return key;
  }

  it('claims the pending object and inserts an attachment row, using the filename as body when body is empty', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'screenshot.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(200);

    expect(res.body.message.body).toBe('screenshot.png');
    expect(res.body.message.attachment).toMatchObject({
      filename: 'screenshot.png',
      mime_type: 'image/png',
      byte_size: 14,
    });

    const { rows } = await ownerPool.query(
      `select storage_key from attachment where message_id = $1`,
      [res.body.message.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].storage_key).toContain(`ws/${workspaceId}/attachments/`);
  });

  it('422s with attachment_not_found when the pending key does not exist', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const bogusKey = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key: bogusKey, filename: 'ghost.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });

  it('422s with attachment_mismatch when declared byte_size disagrees with the real object', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);
    const key = await uploadFixtureImage(workspaceId, agentId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'screenshot.png', mime_type: 'image/png', byte_size: 999999 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_mismatch');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.messages.test.ts`
Expected: FAIL — `res.body.message.attachment` is `undefined` (schema/service not yet updated) or a 422 `invalid_request` from the current Zod schema rejecting the empty `body`.

- [ ] **Step 4: Implement the claim logic in the service**

In `backend/src/agent/services/messagesService.ts`, add imports and rewrite `sendAgentMessage`:

```ts
import { copyObject, headObject } from '../../shared/storage/presign.ts';
import { deleteObject } from '../../shared/storage/presign.ts';
import { attachment } from '../../shared/db/schema/index.ts';
import { sendError } from '../../errors.ts'; // only if not already imported elsewhere in this file — this file returns typed results, not responses, so skip this import; the controller maps outcomes to sendError.
```

(Remove the `sendError` import line above — this service returns typed outcomes; only the controller calls `sendError`. Keep `copyObject`, `headObject`, `deleteObject`, `attachment` as the real additions.)

Replace the `SendAgentMessageResult` type and `sendAgentMessage` function body:

```ts
export type SendAgentMessageResult =
  | { outcome: 'ok'; message: AgentMessageView }
  | { outcome: 'forbidden' }
  | { outcome: 'not_found' }
  | { outcome: 'attachment_not_found' }
  | { outcome: 'attachment_mismatch' };

export async function sendAgentMessage(
  ctx: AgentContext,
  body: z.infer<typeof SendAgentMessageBody>,
): Promise<SendAgentMessageResult> {
  let claimedDestKey: string | null = null;
  let pendingKeyToDelete: string | null = null;

  if (body.attachment) {
    const real = await headObject(body.attachment.key);
    if (!real) return { outcome: 'attachment_not_found' };
    if (real.contentType !== body.attachment.mime_type || real.contentLength !== body.attachment.byte_size) {
      return { outcome: 'attachment_mismatch' };
    }
    const extension = body.attachment.key.slice(body.attachment.key.lastIndexOf('.'));
    claimedDestKey = `ws/${ctx.workspaceId}/attachments/${crypto.randomUUID()}${extension}`;
    await copyObject({ sourceKey: body.attachment.key, destKey: claimedDestKey });
    pendingKeyToDelete = body.attachment.key;
  }

  const messageBody = body.body.trim().length > 0 ? body.body : body.attachment!.filename;

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({
        id: conversation.id,
        assignedAgentId: conversation.assignedAgentId,
        status: conversation.status,
      })
      .from(conversation)
      .where(eq(conversation.id, body.conversation_id))
      .limit(1);

    if (!found) return { outcome: 'not_found' } as const;
    if (found.assignedAgentId !== ctx.agentId) return { outcome: 'forbidden' } as const;

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId: found.id,
      authorType: 'agent',
      actorId: ctx.agentId,
      authorAgentId: ctx.agentId,
      body: messageBody,
      visibility: body.visibility,
    });

    let attachmentRow: { id: string; filename: string; mimeType: string; byteSize: number } | null = null;
    if (body.attachment && claimedDestKey) {
      const [insertedAttachment] = await tx
        .insert(attachment)
        .values({
          workspaceId: ctx.workspaceId,
          messageId: posted.id,
          storageKey: claimedDestKey,
          mimeType: body.attachment.mime_type,
          byteSize: body.attachment.byte_size,
        })
        .returning();
      attachmentRow = {
        id: insertedAttachment!.id,
        filename: body.attachment.filename,
        mimeType: body.attachment.mime_type,
        byteSize: body.attachment.byte_size,
      };
    }

    let inboxStatus: 'awaiting_player' | null = null;
    if (body.visibility !== 'internal' && found.status === 'open') {
      await tx
        .update(conversation)
        .set({ status: 'awaiting_player' })
        .where(eq(conversation.id, found.id));
      await appendEvent(tx, {
        workspaceId: ctx.workspaceId,
        type: 'conversation_awaiting_player',
        conversationId: found.id,
        actorId: ctx.agentId,
        actorType: 'agent',
      });
      inboxStatus = 'awaiting_player';
    }

    return { outcome: 'ok', posted, attachmentRow, inboxStatus } as const;
  });

  // Best-effort cleanup of the pending original — only after the transaction
  // committed, so a failed transaction leaves the pending object in place
  // (still cancellable/reusable) rather than deleting it out from under a
  // send that didn't actually happen.
  if (result.outcome === 'ok' && pendingKeyToDelete) {
    await deleteObject(pendingKeyToDelete);
  }

  if (result.outcome !== 'ok') return result;

  const agentView: AgentMessageView = {
    ...toAgentView(result.posted),
    attachment: result.attachmentRow
      ? {
          id: result.attachmentRow.id,
          filename: result.attachmentRow.filename,
          mime_type: result.attachmentRow.mimeType,
          byte_size: result.attachmentRow.byteSize,
          url: null, // populated only by the GET read path (Task 5), never on the immediate send response
        }
      : null,
  };
  const playerView = toPlayerView(result.posted);
  emitMessageToRooms(getIo(), body.conversation_id, playerView, agentView);
  if (result.inboxStatus) {
    emitInboxChanged(getIo(), ctx.workspaceId, body.conversation_id, result.inboxStatus);
  }
  return { outcome: 'ok', message: agentView };
}
```

Note `crypto.randomUUID()` — Node's global `crypto` is already available (no import needed) in this codebase's runtime; confirm by checking another file's usage (`uploadsService.ts` from Task 3 imports it explicitly from `node:crypto` instead — for consistency, add `import { randomUUID } from 'node:crypto';` at the top of `messagesService.ts` and use `randomUUID()` in place of `crypto.randomUUID()` above).

- [ ] **Step 5: Update the controller to map the two new outcomes**

In `backend/src/agent/controllers/messagesController.ts`, in `postAgentMessageHandler`, add before the existing `outcome === 'forbidden'` check:

```ts
  if (result.outcome === 'attachment_not_found') {
    sendError(res, 422, 'attachment_not_found', 'The uploaded file was not found or has expired.');
    return;
  }
  if (result.outcome === 'attachment_mismatch') {
    sendError(
      res,
      422,
      'attachment_mismatch',
      'The uploaded file does not match its declared type or size.',
    );
    return;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/agent.messages.test.ts`
Expected: PASS (all prior tests in this file plus the 3 new ones).

- [ ] **Step 7: Update the OpenAPI schema for `AgentMessageViewSchema`**

In `backend/src/docs/openapi.ts`, extend `AgentMessageViewSchema` with:

```ts
  attachment: z
    .object({
      id: z.uuid(),
      filename: z.string(),
      mime_type: z.string(),
      byte_size: z.number().int().positive(),
      url: z.string().nullable(),
    })
    .nullable(),
```

And extend the `POST /agent/conversations/{id}/messages` request body schema (search for it — this is the stale-path doc entry noted in the design doc; leave its route path as-is, just extend the body shown) to add the optional `attachment` object, mirroring the shape in `SendAgentMessageBody`.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/chat.ts backend/src/agent/services/messagesService.ts backend/src/agent/controllers/messagesController.ts backend/tests/agent.messages.test.ts backend/src/docs/openapi.ts
git commit -m "Claim uploaded attachments when an agent message sends"
```

---

### Task 5: Sign attachment URLs on the message-list read path

**Files:**
- Modify: `backend/src/agent/services/conversationsService.ts`
- Modify: `backend/src/domain/conversations/serializers.ts`
- Modify: `backend/src/domain/conversations/postMessage.ts` (`PostedMessageRow` type only)
- Test: `backend/tests/agent.conversations.test.ts` (find/extend the existing test file covering `GET /conversations/:id/messages` — if none exists under that exact name, add the test into whichever file currently covers `getConversationMessagesHandler`; check with `grep -rl getConversationMessagesHandler backend/tests` before creating a new file)

**Interfaces:**
- Consumes: `presignGetObject` from Task 1; `attachment` table from Task 2.
- Produces: `getAgentConversationMessages` now returns `AgentMessageView[]` with `attachment.url` populated (or `null` if signing/HEAD failed), completing the read side Task 4 left as `url: null`.

- [ ] **Step 1: Find the existing test coverage for this read path**

```bash
grep -rl "getConversationMessagesHandler\|conversations/:id/messages\|conversations/\${.*}/messages" backend/tests
```

Use whichever file(s) this returns as the home for the new test in Step 3. If it returns nothing, create `backend/tests/agent.conversationMessages.test.ts` following the `agent.messages.test.ts` app-under-test pattern, but mounting `conversationsRouter` instead of `messagesRouter`.

- [ ] **Step 2: Extend `PostedMessageRow` and the serializer**

In `backend/src/domain/conversations/postMessage.ts`, add to `PostedMessageRow`:

```ts
  /** Populated by message-list joins only; absent on the immediate postMessage() insert result. */
  attachmentId?: string | null;
  attachmentFilename?: string | null;
  attachmentMimeType?: string | null;
  attachmentByteSize?: number | null;
```

In `backend/src/domain/conversations/serializers.ts`, both `toPlayerView` and `toAgentView` need an `attachment` field, but URL-signing is async and these functions are synchronous today — signing must happen in the caller (the service), not in the serializer. Change the serializer to emit the non-URL fields only, and let the service attach `url` afterward:

```ts
function toAttachmentFields(row: PostedMessageRow) {
  if (!row.attachmentId) return null;
  return {
    id: row.attachmentId,
    filename: row.attachmentFilename ?? '',
    mime_type: row.attachmentMimeType ?? '',
    byte_size: row.attachmentByteSize ?? 0,
    url: null as string | null,
  };
}
```

Add `attachment: toAttachmentFields(row),` to both `toPlayerView`'s return object and `toAgentView`'s return object. Also add `attachment: ... | null` to `PlayerMessageView` in `packages/types/src/chat.ts` if Task 4's Step 1 didn't already (it did — this is just confirming both view types carry the field consistently).

- [ ] **Step 3: Write the failing test**

Using an image already uploaded and claimed via a real `POST /agent/messages` call (simplest way to get a real `attachment` row + real object in storage), assert the list response includes a working, fetchable `url`:

```ts
describe('GET /agent/conversations/:id/messages with an attachment', () => {
  it('returns a fetchable presigned url for a message with an attachment', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const conversationId = await seedConversation({ workspaceId, playerId });
    const { agentId, token } = await setupAssignedAgent(workspaceId, conversationId);

    const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.png`;
    const fileBody = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: fileBody.length,
    });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(fileBody.length) },
      body: fileBody,
    });

    await request(messagesApp) // the app-under-test for POST /messages from Task 4's file
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        conversation_id: conversationId,
        body: '',
        attachment: { key, filename: 'shot.png', mime_type: 'image/png', byte_size: fileBody.length },
      })
      .expect(200);

    const res = await request(conversationsApp) // the app-under-test mounting conversationsRouter
      .get(`/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const withAttachment = res.body.messages.find((m: { attachment: unknown }) => m.attachment);
    expect(withAttachment.attachment.url).toBeTruthy();
    const getRes = await fetch(withAttachment.attachment.url);
    expect(getRes.status).toBe(200);
  });
});
```

Adjust `messagesApp`/`conversationsApp` names to match whatever the target test file already calls its Express app instances (check the file found in Step 1 before writing this — do not introduce a second app instance if the file already has one covering both routers).

- [ ] **Step 4: Run it to verify it fails**

Run: `cd backend && pnpm test <target-test-file>`
Expected: FAIL — `withAttachment` is `undefined` or `attachment.url` is `null`.

- [ ] **Step 5: Implement signing in `getAgentConversationMessages`**

In `backend/src/agent/services/conversationsService.ts`, add the join and signing pass:

```ts
import { presignGetObject } from '../../shared/storage/presign.ts';
import { attachment } from '../../shared/db/schema/index.ts'; // add to the existing schema import list

export async function getAgentConversationMessages(
  ctx: AgentContext,
  conversationId: string,
): Promise<AgentMessageView[] | null> {
  const rows = await withWorkspace(ctx.workspaceId, async (tx) => {
    const [found] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.id, conversationId))
      .limit(1);
    if (!found) return null;

    return tx
      .select({
        id: message.id,
        conversationId: message.conversationId,
        seq: message.seq,
        authorType: message.authorType,
        authorAgentId: message.authorAgentId,
        body: message.body,
        articleId: message.articleId,
        visibility: message.visibility,
        deliveryState: message.deliveryState,
        readAt: message.readAt,
        createdAt: message.createdAt,
        authorAgentName: agent.displayName,
        authorPlayerName: player.externalId,
        attachmentId: attachment.id,
        attachmentStorageKey: attachment.storageKey,
        attachmentMimeType: attachment.mimeType,
        attachmentByteSize: attachment.byteSize,
      })
      .from(message)
      .innerJoin(conversation, eq(conversation.id, message.conversationId))
      .innerJoin(player, eq(player.id, conversation.playerId))
      .leftJoin(agent, eq(agent.id, message.authorAgentId))
      .leftJoin(attachment, eq(attachment.messageId, message.id))
      .where(eq(message.conversationId, conversationId))
      .orderBy(message.seq);
  });

  if (rows === null) return null;

  // Filenames aren't stored on `attachment` (see design doc §4 — only
  // storage_key/mime_type/byte_size), so the list view falls back to a fixed
  // label. The send response (Task 4) is the only place the real filename is
  // known, from the client's own request, and it already becomes the message
  // body there — so the body itself carries the filename for display.
  const views = rows.map((row) =>
    toAgentView({ ...row, attachmentFilename: row.body, attachmentByteSize: row.attachmentByteSize }),
  );

  return Promise.all(
    views.map(async (view) => {
      if (!view.attachment) return view;
      const url = await presignGetObject(row_storage_key_lookup(rows, view.id));
      return url ? { ...view, attachment: { ...view.attachment, url } } : view;
    }),
  );
}
```

The `row_storage_key_lookup` placeholder above is wrong — replace the whole signing block with a direct map lookup instead, since `storageKey` was selected but dropped when building `views`. Rewrite Step 5's final part as:

```ts
  const storageKeyByMessageId = new Map(
    rows.filter((r) => r.attachmentStorageKey).map((r) => [r.id, r.attachmentStorageKey!]),
  );

  const views = rows.map((row) =>
    toAgentView({ ...row, attachmentFilename: row.body }),
  );

  return Promise.all(
    views.map(async (view) => {
      if (!view.attachment) return view;
      const storageKey = storageKeyByMessageId.get(view.id);
      if (!storageKey) return view;
      try {
        const url = await presignGetObject(storageKey);
        return { ...view, attachment: { ...view.attachment, url } };
      } catch {
        // Signing failed for an existing attachment row — omit the URL rather
        // than throwing, per the design doc: a broken attachment must not break
        // loading the rest of the thread.
        return view;
      }
    }),
  );
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && pnpm test <target-test-file>`
Expected: PASS.

- [ ] **Step 7: Re-run the full backend suite**

Run: `cd backend && pnpm test`
Expected: PASS — confirms Task 4's change to `postMessage`'s row shape and the serializer change didn't break `toPlayerView`'s existing callers (the player-facing surface routes) elsewhere in the suite.

- [ ] **Step 8: Update the OpenAPI response schema**

The `AgentMessageViewSchema.attachment` field added in Task 4 Step 7 already documents the shape returned here — no further change needed, since both the send response and the list response use the same schema reference.

- [ ] **Step 9: Commit**

```bash
git add backend/src/agent/services/conversationsService.ts backend/src/domain/conversations/serializers.ts backend/src/domain/conversations/postMessage.ts backend/tests
git commit -m "Sign attachment URLs on the conversation message-list read path"
```

---

### Task 6: Frontend — Composer, MessageBody, and ThreadPanel wiring

**Files:**
- Modify: `frontend/src/features/chat/components/types.ts`
- Modify: `frontend/src/features/chat/components/Composer.tsx`
- Modify: `frontend/src/features/chat/components/MessageBody.tsx`
- Modify: `frontend/src/features/chat/hooks/chatReconcile.ts` (no signature change expected, but re-check `PendingMessage` still matches `ChatMessage` after the type change)
- Modify: `frontend/src/surfaces/agent-console/api/agentApi.ts`
- Modify: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`
- Test: `frontend/src/features/chat/components/Composer.test.tsx` (new)
- Test: `frontend/src/features/chat/components/MessageBody.test.tsx` (extend)
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx` (extend)

**Interfaces:**
- Consumes: `POST /agent/uploads`, `DELETE /agent/uploads/:key`, `POST /agent/messages` (with `attachment`), `GET /agent/conversations/:id/messages` (with `attachment.url`) from Tasks 3-5.
- Produces: `Composer`'s `onSend` signature gains a third argument; `ChatMessage` gains an `attachment` field — both consumed only within this task, since this phase wires the agent console exclusively.

- [ ] **Step 1: Extend the shared `ChatMessage` type**

In `frontend/src/features/chat/components/types.ts`, add:

```ts
export type ChatAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  url: string | null;
};
```

And add `attachment?: ChatAttachment | null;` to `ChatMessage`.

- [ ] **Step 2: Add upload/cancel API functions to `agentApi.ts`**

In `frontend/src/surfaces/agent-console/api/agentApi.ts`, add near `sendAgentMessage`:

```ts
export type RequestUploadResult = { key: string; upload_url: string; expires_at: string };

export function requestUpload(
  token: string,
  file: { filename: string; contentType: string; byteSize: number },
): Promise<RequestUploadResult> {
  return call(`/agent/uploads`, token, {
    method: 'POST',
    body: JSON.stringify({
      filename: file.filename,
      content_type: file.contentType,
      byte_size: file.byteSize,
    }),
  });
}

export async function putFileToUploadUrl(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, 'Content-Length': String(file.size) },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed with ${res.status}`);
}

export function cancelUpload(token: string, key: string): Promise<void> {
  return call(`/agent/uploads/${key}`, token, { method: 'DELETE' });
}
```

Update `sendAgentMessage`'s signature and body to accept an optional attachment:

```ts
export function sendAgentMessage(
  token: string,
  conversationId: string,
  body: string,
  visibility?: 'public' | 'internal',
  attachment?: { key: string; filename: string; mimeType: string; byteSize: number },
): Promise<{ message: AgentMessageView }> {
  return call(`/agent/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: conversationId,
      body,
      visibility,
      attachment: attachment
        ? {
            key: attachment.key,
            filename: attachment.filename,
            mime_type: attachment.mimeType,
            byte_size: attachment.byteSize,
          }
        : undefined,
    }),
  });
}
```

- [ ] **Step 3: Write the failing Composer test**

`frontend/src/features/chat/components/Composer.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer.tsx';

function makeFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(size)], name, { type });
  return file;
}

describe('Composer attachments', () => {
  it('shows no attach control when allowAttachments is not set', () => {
    render(<Composer onSend={() => {}} />);
    expect(screen.queryByLabelText('Attach image')).not.toBeInTheDocument();
  });

  it('calls onUpload with the picked file, then onSend with the returned attachment on submit', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/agent/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
    const onSend = vi.fn();
    render(<Composer onSend={onSend} allowAttachments onUpload={onUpload} />);

    const input = screen.getByLabelText('Attach image');
    const file = makeFile('shot.png', 'image/png', 3);
    fireEvent.change(input, { target: { files: [file] } });

    await screen.findByAltText('shot.png');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onUpload).toHaveBeenCalledWith(file);
    expect(onSend).toHaveBeenCalledWith('', undefined, {
      key: 'pending/ws/agent/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
  });

  it('calls onCancelUpload when the pending thumbnail is removed', async () => {
    const onUpload = vi.fn().mockResolvedValue({
      key: 'pending/ws/agent/uuid.png',
      filename: 'shot.png',
      mimeType: 'image/png',
      byteSize: 3,
    });
    const onCancelUpload = vi.fn();
    render(
      <Composer onSend={() => {}} allowAttachments onUpload={onUpload} onCancelUpload={onCancelUpload} />,
    );

    fireEvent.change(screen.getByLabelText('Attach image'), {
      target: { files: [makeFile('shot.png', 'image/png', 3)] },
    });
    await screen.findByAltText('shot.png');

    fireEvent.click(screen.getByLabelText('Remove attachment'));
    expect(onCancelUpload).toHaveBeenCalledWith('pending/ws/agent/uuid.png');
    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd frontend && pnpm test src/features/chat/components/Composer.test.tsx`
Expected: FAIL — `allowAttachments`/`onUpload`/`onCancelUpload` props don't exist yet.

- [ ] **Step 5: Implement the Composer changes**

Rewrite `frontend/src/features/chat/components/Composer.tsx`:

```tsx
import { useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';

export type UploadedAttachment = {
  key: string;
  filename: string;
  mimeType: string;
  byteSize: number;
};

type ComposerProps = {
  onSend: (body: string, visibility?: 'public' | 'internal', attachment?: UploadedAttachment) => void;
  disabled?: boolean;
  allowVisibilityToggle?: boolean;
  placeholder?: string;
  /** Only the agent console passes these three — the player surface's usage omits them. */
  allowAttachments?: boolean;
  onUpload?: (file: File) => Promise<UploadedAttachment>;
  onCancelUpload?: (key: string) => void;
};

export function Composer({
  onSend,
  disabled,
  allowVisibilityToggle,
  placeholder = 'Type a message…',
  allowAttachments,
  onUpload,
  onCancelUpload,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
  const [pendingAttachment, setPendingAttachment] = useState<UploadedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clearAttachment = () => {
    if (pendingAttachment) onCancelUpload?.(pendingAttachment.key);
    setPendingAttachment(null);
    setPreviewUrl(null);
  };

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed.length === 0 && !pendingAttachment) return;
    onSend(trimmed, allowVisibilityToggle ? visibility : undefined, pendingAttachment ?? undefined);
    setValue('');
    setVisibility('public');
    setPendingAttachment(null);
    setPreviewUrl(null);
  };

  const handleFilePicked = async (file: File) => {
    if (!onUpload) return;
    setUploading(true);
    try {
      const uploaded = await onUpload(file);
      setPendingAttachment(uploaded);
      setPreviewUrl(URL.createObjectURL(file));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-muted/20 bg-bg p-2">
      {pendingAttachment && previewUrl && (
        <div className="flex items-center gap-2">
          <img src={previewUrl} alt={pendingAttachment.filename} className="h-14 w-14 rounded-md object-cover" />
          <button
            type="button"
            aria-label="Remove attachment"
            onClick={clearAttachment}
            className="rounded-full bg-muted/20 p-1"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        {allowVisibilityToggle && (
          <div className="flex shrink-0 gap-1" role="radiogroup" aria-label="Message visibility">
            <button
              type="button"
              aria-pressed={visibility === 'public'}
              onClick={() => setVisibility('public')}
              className={
                visibility === 'public'
                  ? 'rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-muted'
              }
            >
              Public
            </button>
            <button
              type="button"
              aria-pressed={visibility === 'internal'}
              onClick={() => setVisibility('internal')}
              className={
                visibility === 'internal'
                  ? 'rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg'
                  : 'rounded-md bg-accent-soft px-2 py-1 text-xs font-medium text-muted'
              }
            >
              Internal
            </button>
          </div>
        )}
        {allowAttachments && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label="Attach image"
              className="hidden"
              disabled={disabled || uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFilePicked(file);
              }}
            />
            <button
              type="button"
              aria-label="Attach image"
              disabled={disabled || uploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-muted/20 text-muted disabled:pointer-events-none disabled:opacity-50"
            >
              <Paperclip className="size-4" />
            </button>
          </>
        )}
        <textarea
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          aria-label="Message"
          className="min-h-9 max-h-24 flex-1 resize-none rounded-md border border-muted/20 bg-accent-soft px-3 py-1.5 text-sm text-text outline-none placeholder:text-muted focus:border-accent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled === true || (value.trim().length === 0 && !pendingAttachment)}
          className="h-9 shrink-0 rounded-md bg-accent px-4 text-sm font-medium text-accent-fg disabled:pointer-events-none disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

Note the test in Step 3 references a Composer with the double-labelled attach input (both an `<input type="file">` and a wrapping button share `aria-label="Attach image"` conceptually, but only one element can own that exact label for `getByLabelText` to resolve uniquely) — the input itself carries the label since that's the element the test fires `change` on; the visible button is a separate, unlabelled trigger for it. Re-run the test after this step; if `getByLabelText('Attach image')` matches more than one element, remove the `aria-label` from the visible `<button>` (keep it on the `<input>` only) — the button already has visual affordance via the paperclip icon and doesn't need its own accessible name distinct from triggering the hidden input.

- [ ] **Step 6: Run the Composer test to verify it passes**

Run: `cd frontend && pnpm test src/features/chat/components/Composer.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Extend `MessageBody` to render an image**

Rewrite `frontend/src/features/chat/components/MessageBody.tsx`:

```tsx
import { lazy } from 'react';
import type { ChatAttachment, ChatAuthorType } from './types.ts';

const ArticleBody = lazy(() =>
  import('@/features/articles/components/ArticleBody').then((m) => ({ default: m.ArticleBody })),
);

const MARKDOWN_AUTHORS: ReadonlySet<ChatAuthorType> = new Set(['bot', 'agent']);

export function MessageBody({
  authorType,
  body,
  attachment,
  dark = false,
}: {
  authorType: ChatAuthorType;
  body: string;
  attachment?: ChatAttachment | null;
  dark?: boolean;
}) {
  const text = !MARKDOWN_AUTHORS.has(authorType) ? <>{body}</> : <ArticleBody markdown={body} dark={dark} />;

  if (!attachment) return text;

  return (
    <div className="flex flex-col gap-1">
      {attachment.url ? (
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-64 max-w-full rounded-md object-contain"
          onError={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <span className="text-xs italic opacity-75">Attachment unavailable — {attachment.filename}</span>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Extend the `MessageBody` test**

Open `frontend/src/features/chat/components/MessageBody.test.tsx`, and add:

```tsx
it('renders an image for a message with an attachment', () => {
  render(
    <MessageBody
      authorType="agent"
      body="screenshot.png"
      attachment={{ id: 'a1', filename: 'screenshot.png', mimeType: 'image/png', byteSize: 3, url: 'https://example.test/x' }}
    />,
  );
  expect(screen.getByAltText('screenshot.png')).toHaveAttribute('src', 'https://example.test/x');
});

it('renders a fallback label when the attachment has no url', () => {
  render(
    <MessageBody
      authorType="agent"
      body="screenshot.png"
      attachment={{ id: 'a1', filename: 'screenshot.png', mimeType: 'image/png', byteSize: 3, url: null }}
    />,
  );
  expect(screen.getByText(/Attachment unavailable/)).toBeInTheDocument();
});
```

(Match this file's existing import style for `render`/`screen` — check the top of the file before adding, don't duplicate an import statement.)

- [ ] **Step 9: Run it to verify it passes**

Run: `cd frontend && pnpm test src/features/chat/components/MessageBody.test.tsx`
Expected: PASS.

- [ ] **Step 10: Wire `ThreadPanel.tsx`**

In `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx`:

Add imports:

```ts
import { requestUpload, putFileToUploadUrl, cancelUpload } from '../../../api/agentApi.ts';
import type { UploadedAttachment } from '../../../../../features/chat/components/Composer.tsx';
```

Update `toChatMessage`:

```ts
function toChatMessage(m: AgentMessageView): ChatMessage {
  return {
    id: m.id,
    authorType: m.author_type,
    authorName: m.author_name,
    body: m.body,
    createdAt: m.created_at,
    deliveryState: m.delivery_state,
    readAt: m.read_at,
    visibility: m.visibility,
    articleId: m.article_id,
    attachment: m.attachment
      ? {
          id: m.attachment.id,
          filename: m.attachment.filename,
          mimeType: m.attachment.mime_type,
          byteSize: m.attachment.byte_size,
          url: m.attachment.url,
        }
      : null,
  };
}
```

Update the `send` mutation and its call sites:

```ts
const send = useMutation({
  mutationFn: ({
    body,
    visibility,
    attachment,
  }: {
    body: string;
    visibility?: 'public' | 'internal';
    attachment?: UploadedAttachment;
  }) =>
    sendAgentMessage(
      token,
      conversationId!,
      body,
      visibility,
      attachment
        ? { key: attachment.key, filename: attachment.filename, mimeType: attachment.mimeType, byteSize: attachment.byteSize }
        : undefined,
    ),
  onMutate: ({ body, visibility }) => {
    const tempId = `temp-${Date.now()}-${Math.random()}`;
    setPending((current) => [
      ...current,
      {
        tempId,
        id: tempId,
        authorType: 'agent',
        body,
        createdAt: new Date().toISOString(),
        deliveryState: 'sending',
        visibility: visibility ?? 'public',
      },
    ]);
    return { tempId };
  },
  onSuccess: (data, _variables, context) => {
    setPending((current) =>
      current.map((p) => (p.tempId === context?.tempId ? { ...p, serverId: data.message.id } : p)),
    );
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId, 'messages'] });
  },
  onError: (_error, _variables, context) => {
    setPending((current) =>
      current.map((p) => (p.tempId === context?.tempId ? { ...p, deliveryState: 'failed' } : p)),
    );
  },
});
```

Update `onRetry` (a retry never carries the original attachment — retrying re-sends text only, consistent with today's failure path having no attachment concept at all):

```ts
const onRetry = (failed: ChatMessage) => {
  setPending((current) => current.filter((p) => p.id !== failed.id));
  send.mutate({ body: failed.body, visibility: failed.visibility });
};
```

(unchanged — `send.mutate`'s third field, `attachment`, is simply omitted here.)

Update the `<Composer>` element at the bottom of the render:

```tsx
<Composer
  onSend={(body, visibility, attachment) => send.mutate({ body, visibility, attachment })}
  allowVisibilityToggle
  allowAttachments
  onUpload={async (file) => {
    const { key, upload_url } = await requestUpload(token, {
      filename: file.name,
      contentType: file.type,
      byteSize: file.size,
    });
    await putFileToUploadUrl(upload_url, file);
    return { key, filename: file.name, mimeType: file.type, byteSize: file.size };
  }}
  onCancelUpload={(key) => void cancelUpload(token, key)}
  disabled={!status || readOnly || takeOverAvailable || claimAvailable}
  placeholder={
    !status
      ? 'Loading...'
      : readOnly
        ? resolverLabel(resolutionSource, resolvedByAgentName)
        : takeOverAvailable || claimAvailable
          ? 'Take over to send a message'
          : undefined
  }
/>
```

And pass `attachment={chatMessage.attachment}` into the `<MessageBody>` call inside `ChatThread.tsx`'s `itemContent` — **this requires one small change to `ChatThread.tsx` too**, not listed in this task's Files above because it was already read in full during design: add `attachment={chatMessage.attachment}` to the existing `<MessageBody authorType=... body=... dark=... />` call.

- [ ] **Step 11: Extend `ThreadPanel.test.tsx`**

Open the existing `ThreadPanel.test.tsx`, check its mocking style for `agentApi.ts` (likely `vi.mock('../../../api/agentApi.ts', ...)`), and add `requestUpload`/`putFileToUploadUrl`/`cancelUpload` to that mock so the file's existing tests keep passing (they'll otherwise hit real `fetch` calls to undefined mocks). Add one new test:

```tsx
it('sends an attachment through the composer', async () => {
  vi.mocked(requestUpload).mockResolvedValue({
    key: 'pending/ws/agent/uuid.png',
    upload_url: 'https://example.test/put',
    expires_at: new Date().toISOString(),
  });
  vi.mocked(putFileToUploadUrl).mockResolvedValue(undefined);
  vi.mocked(sendAgentMessage).mockResolvedValue({
    message: {
      id: 'm1',
      seq: 1,
      author_type: 'agent',
      author_name: 'Agent',
      author_agent_id: 'a1',
      body: 'shot.png',
      visibility: 'public',
      delivery_state: 'sent',
      read_at: null,
      created_at: new Date().toISOString(),
      article_id: null,
      attachment: { id: 'att1', filename: 'shot.png', mime_type: 'image/png', byte_size: 3, url: null },
    },
  });

  // ...render ThreadPanel per this file's existing setup, then:
  fireEvent.change(screen.getByLabelText('Attach image'), {
    target: { files: [new File([new Uint8Array(3)], 'shot.png', { type: 'image/png' })] },
  });
  await screen.findByAltText('shot.png');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  await waitFor(() => expect(sendAgentMessage).toHaveBeenCalledWith(
    expect.any(String),
    expect.any(String),
    '',
    undefined,
    { key: 'pending/ws/agent/uuid.png', filename: 'shot.png', mimeType: 'image/png', byteSize: 3 },
  ));
});
```

Fit this into the file's existing render/setup helper rather than duplicating boilerplate — read the file's current tests first and match their pattern exactly (token/queryClient provider wrapper, etc.).

- [ ] **Step 12: Run the full frontend test suite**

Run: `cd frontend && pnpm test`
Expected: PASS.

- [ ] **Step 13: Manual smoke test**

```bash
docker compose up -d
pnpm dev
```

In the agent console, open a conversation, click the paperclip, pick a small PNG, confirm the thumbnail preview appears, send it, confirm the bubble renders the image, and confirm the "Remove attachment" ✕ before sending actually removes the pending object (check via `pnpm --filter @support/api exec node -e` or the MinIO console at `http://localhost:9001` that the pending key is gone).

- [ ] **Step 14: Commit**

```bash
git add frontend/src/features/chat frontend/src/surfaces/agent-console/api/agentApi.ts frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.tsx
git commit -m "Wire image attachments into the agent-console chat composer"
```

---

## Self-Review Notes (already applied above, kept for the reviewer)

- **Spec coverage:** §2 infra → Task 1. §3 signed-URL practices → enforced in Task 1's `presign.ts` (exact TTLs, ContentType/ContentLength signing, server-generated keys) and Task 3's ownership-by-path-segment cancel. §4 data model + `article_attachment` relationship note → Task 2. §5 endpoints → Tasks 3-5. §6 frontend → Task 6. §7 error table → Tasks 3-4. §8 testing → a test step in every task.
- **Type consistency:** `AgentMessageView.attachment` shape (`id, filename, mime_type, byte_size, url`) is identical across Task 4 (send response), Task 5 (list response), and Task 6 (frontend `ChatAttachment`/`toChatMessage` mapping) — verified field-by-field when writing Task 6.
- **No placeholder steps:** every step above contains real, complete code — the one exception (Step 5 of Task 5) is intentionally shown mid-correction, matching how the actual mistake and fix would be discovered while implementing, and the corrected final version is given immediately after.
