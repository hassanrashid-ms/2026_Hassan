# Video Attachments in Chat + Form Attachment Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing image-only attachment pipeline (agent console chat, player webview chat, and the form `attachment` field) to also accept `video/mp4` and `video/webm`, up to 50MB, rendering as an inline `<video controls>` player instead of the image tile.

**Architecture:** Policy + rendering change only — no schema migration, no new endpoints, no new field type. The `attachment` table and the presigned-upload/claim/send flow already store `mimeType`/`storageKey` generically. This plan (1) widens the mime-type allowlist and adds a type-dependent size cap in the one shared backend policy module, swapping every chat/forms call site over to it, and (2) branches the frontend's attachment renderer and pending-upload preview on `mimeType`. Article/Knowledge-Base image uploads keep using the original image-only constants, untouched.

**Tech Stack:** Same as the rest of the repo — Express 5, Zod, Drizzle, `@aws-sdk/client-s3` via the existing presign choke point, React, Vitest/Testing Library.

## Global Constraints

- Formats: `video/mp4`, `video/webm` only. No `video/quicktime` (MOV).
- Size caps: video 50MB (`MAX_VIDEO_BYTES`), images stay at the existing 10MB (`MAX_ATTACHMENT_BYTES`) — unchanged.
- Article/Knowledge-Base image uploads (`backend/src/agent/services/articlesService.ts`, `frontend/src/surfaces/agent-console/pages/KnowledgeBase/components/ImageDialogAdapter.tsx`, `frontend/src/components/ImageInsertDialog.tsx`) are **not** touched — they keep using `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` directly.
- Every frontend accept-filter/size-cap duplicate must mirror the backend policy exactly (existing repo convention — the frontend doesn't import backend code).
- The file-input `aria-label` changes from `"Attach image"` to `"Attach image or video"` everywhere a chat/form attachment picker exists (Composer, ChatComposer, FormCard) — every test asserting the old label text must be updated in the same task that changes the component.
- Follow existing repo conventions: `sendError(res, status, code, message)`, `logger` never `console.*`, RLS/tenancy rules are unaffected by this plan (no new queries).

---

### Task 1: Backend — shared video mime/size policy

**Files:**

- Modify: `backend/src/shared/storage/presign.ts`
- Test: `backend/tests/storage.presign.test.ts` (extend)

**Interfaces:**

- Produces: `ALLOWED_VIDEO_MIME_TYPES: readonly string[]`, `MAX_VIDEO_BYTES: number`, `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES: readonly string[]` (images ∪ video), `maxBytesForAttachment(contentType: string): number` — all consumed by Tasks 2–5.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/storage.presign.test.ts`:

```ts
import {
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  MAX_VIDEO_BYTES,
  maxBytesForAttachment,
} from '../src/shared/storage/presign.ts';

describe('maxBytesForAttachment', () => {
  it('returns the video cap for an allowed video type', () => {
    expect(maxBytesForAttachment('video/mp4')).toBe(MAX_VIDEO_BYTES);
    expect(maxBytesForAttachment('video/webm')).toBe(MAX_VIDEO_BYTES);
  });

  it('returns the image cap for an image type or anything else', () => {
    expect(maxBytesForAttachment('image/png')).toBe(MAX_ATTACHMENT_BYTES);
    expect(maxBytesForAttachment('application/pdf')).toBe(MAX_ATTACHMENT_BYTES);
  });
});

describe('ALLOWED_CHAT_ATTACHMENT_MIME_TYPES', () => {
  it('includes both images and video', () => {
    expect(ALLOWED_CHAT_ATTACHMENT_MIME_TYPES).toContain('image/png');
    expect(ALLOWED_CHAT_ATTACHMENT_MIME_TYPES).toContain('video/mp4');
    expect(ALLOWED_CHAT_ATTACHMENT_MIME_TYPES).toContain('video/webm');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/storage.presign.test.ts`
Expected: FAIL — `maxBytesForAttachment`/`ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`/`MAX_VIDEO_BYTES` don't exist yet.

- [ ] **Step 3: Add the constants and helper**

In `backend/src/shared/storage/presign.ts`, immediately after the existing `MAX_ATTACHMENT_BYTES` declaration:

```ts
export const ALLOWED_VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;

export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_VIDEO_MIME_TYPES,
] as const;

/** Chat/forms attachments only — articles keep the flat MAX_ATTACHMENT_BYTES image cap. */
export function maxBytesForAttachment(contentType: string): number {
  return (ALLOWED_VIDEO_MIME_TYPES as readonly string[]).includes(contentType)
    ? MAX_VIDEO_BYTES
    : MAX_ATTACHMENT_BYTES;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/storage.presign.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/shared/storage/presign.ts backend/tests/storage.presign.test.ts
git commit -m "Add video mime-type allowlist and type-dependent size cap for chat attachments"
```

---

### Task 2: Backend — agent-side upload endpoint accepts video

**Files:**

- Modify: `backend/src/agent/services/uploadsService.ts`
- Modify: `backend/src/agent/controllers/uploadsController.ts`
- Test: `backend/tests/agent.uploads.test.ts` (extend)

**Interfaces:**

- Consumes: `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`, `maxBytesForAttachment` from Task 1.
- Produces: `extensionFor(contentType)` now also maps `video/mp4 → mp4`, `video/webm → webm` — Task 4 (`agent/services/messagesService.ts`) already imports this function and picks up the new mappings automatically, no further change needed there for extensions.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/agent.uploads.test.ts`, inside the existing `describe('POST /agent/uploads', ...)` block, after the `'422s for a byte_size over the cap'` test:

```ts
it('returns a presigned PUT url for an allowed video type', async () => {
  const workspaceId = await seedWorkspace();
  const { agentId, token } = await seedAgentToken(workspaceId);

  const res = await request(app)
    .post('/uploads')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ filename: 'clip.mp4', content_type: 'video/mp4', byte_size: 20 * 1024 * 1024 })
    .expect(200);

  expect(res.body.key).toContain(`pending/${workspaceId}/${agentId}/`);
  expect(res.body.key).toMatch(/\.mp4$/);
});

it('accepts a video between the image cap and the video cap', async () => {
  const workspaceId = await seedWorkspace();
  const { token } = await seedAgentToken(workspaceId);

  await request(app)
    .post('/uploads')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ filename: 'clip.webm', content_type: 'video/webm', byte_size: 30 * 1024 * 1024 })
    .expect(200);
});

it('422s for a video over the 50 MB video cap', async () => {
  const workspaceId = await seedWorkspace();
  const { token } = await seedAgentToken(workspaceId);

  const res = await request(app)
    .post('/uploads')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({ filename: 'huge.mp4', content_type: 'video/mp4', byte_size: 51 * 1024 * 1024 })
    .expect(422);
  expect(res.body.error.code).toBe('invalid_request');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.uploads.test.ts`
Expected: FAIL — `video/mp4`/`video/webm` are rejected as `unsupported_media_type`, and the controller's hardcoded 10MB pre-check 422s the 20MB/30MB video requests before the service even runs.

- [ ] **Step 3: Update the service**

In `backend/src/agent/services/uploadsService.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestUploadBody, RequestUploadResponse } from '@support/types';
import {
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  deleteObject,
  maxBytesForAttachment,
  presignPutObject,
} from '../../shared/storage/presign.ts';
import type { AgentContext } from '../../shared/middleware/requireAgentSession.ts';

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
    default:
      return 'bin';
  }
}
```

(`buildPendingKey` is unchanged — it already calls `extensionFor`.)

Replace the allowlist/size checks in `requestUpload`:

```ts
export async function requestUpload(
  ctx: AgentContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (
    !ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(
      body.content_type as (typeof ALLOWED_CHAT_ATTACHMENT_MIME_TYPES)[number],
    )
  ) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > maxBytesForAttachment(body.content_type)) {
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

- [ ] **Step 4: Update the controller's pre-check**

In `backend/src/agent/controllers/uploadsController.ts`, replace the hardcoded 10MB early-reject (it currently runs before `content_type` is known to be video, so it must use the same type-dependent helper):

```ts
import type { RequestHandler } from 'express';
import { RequestUploadBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { maxBytesForAttachment } from '../../shared/storage/presign.ts';
import { cancelUpload, requestUpload } from '../services/uploadsService.ts';

export const postUploadRequestHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  const body = RequestUploadBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'filename, content_type and byte_size are required.');
    return;
  }
  if (body.data.byte_size > maxBytesForAttachment(body.data.content_type)) {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
    return;
  }

  const result = await requestUpload(ctx, body.data);
  if (result.outcome === 'invalid_media_type') {
    sendError(
      res,
      422,
      'unsupported_media_type',
      'Only PNG, JPEG, WEBP, GIF, MP4 or WEBM are accepted.',
    );
    return;
  }
  if (result.outcome === 'too_large') {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
    return;
  }
  res
    .status(200)
    .json({ key: result.key, upload_url: result.upload_url, expires_at: result.expires_at });
};

export const deleteUploadHandler: RequestHandler = async (req, res) => {
  const ctx = req.agent!;
  // Normalized to a single string by uploadsRouter's wildcard-join middleware.
  const key = req.params.key as string;
  const result = await cancelUpload(ctx, key);
  if (result === 'not_owner') {
    sendError(res, 404, 'not_found', 'Upload not found.');
    return;
  }
  res.status(204).send();
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && pnpm test tests/agent.uploads.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/services/uploadsService.ts backend/src/agent/controllers/uploadsController.ts backend/tests/agent.uploads.test.ts
git commit -m "Accept video uploads on the agent-side presigned upload endpoint"
```

---

### Task 3: Backend — player-side upload endpoint accepts video

**Files:**

- Modify: `backend/src/surface/services/uploadsService.ts`
- Modify: `backend/src/surface/controllers/uploadsController.ts`
- Test: `backend/tests/surface.uploads.test.ts` (extend)

**Interfaces:**

- Consumes: same Task 1 exports.
- Produces: nothing new consumed by later tasks — `surface/services/messagesService.ts` (Task 5) derives its extension from the client-supplied key, not from a shared `extensionFor`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/tests/surface.uploads.test.ts`, inside `describe('POST /uploads (player)', ...)`:

```ts
it('returns a presigned PUT url for an allowed video type', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });

  const res = await request(app)
    .post('/uploads')
    .set('Authorization', `Bearer ${token}`)
    .send({ filename: 'clip.mp4', content_type: 'video/mp4', byte_size: 20 * 1024 * 1024 })
    .expect(200);

  expect(res.body.key).toContain(`pending/${workspaceId}/${playerId}/`);
  expect(res.body.key).toMatch(/\.mp4$/);
});

it('422s for a video over the 50 MB video cap', async () => {
  const workspaceId = await seedWorkspace();
  const playerId = await seedPlayer(workspaceId);
  const token = await mintToken({
    workspace_id: workspaceId,
    player_id: playerId,
    external_player_id: 'p1',
  });

  const res = await request(app)
    .post('/uploads')
    .set('Authorization', `Bearer ${token}`)
    .send({ filename: 'huge.webm', content_type: 'video/webm', byte_size: 51 * 1024 * 1024 })
    .expect(422);
  expect(res.body.error.code).toBe('invalid_request');
});
```

(Match whatever `mintToken`/`seedPlayer` imports the existing file already uses — copy them verbatim from the file's current top-of-file imports, do not re-derive names.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/surface.uploads.test.ts`
Expected: FAIL — video is rejected as `unsupported_media_type`, and the 20MB request 422s on the controller's hardcoded 10MB pre-check.

- [ ] **Step 3: Update the service**

In `backend/src/surface/services/uploadsService.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestUploadBody, RequestUploadResponse } from '@support/types';
import {
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  deleteObject,
  maxBytesForAttachment,
  presignPutObject,
} from '../../shared/storage/presign.ts';
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts';

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
    case 'video/mp4':
      return 'mp4';
    case 'video/webm':
      return 'webm';
    default:
      return 'bin';
  }
}
```

Replace the allowlist/size checks in `requestPlayerUpload`:

```ts
export async function requestPlayerUpload(
  ctx: PlayerContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (
    !ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(
      body.content_type as (typeof ALLOWED_CHAT_ATTACHMENT_MIME_TYPES)[number],
    )
  ) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > maxBytesForAttachment(body.content_type)) {
    return { outcome: 'too_large' };
  }
  const key = buildPendingPlayerKey(ctx.workspaceId, ctx.playerId, body.content_type);
  const { url, expiresAt } = await presignPutObject({
    key,
    contentType: body.content_type,
    contentLength: body.byte_size,
  });
  return { outcome: 'ok', key, upload_url: url, expires_at: expiresAt };
}
```

- [ ] **Step 4: Update the controller's pre-check**

In `backend/src/surface/controllers/uploadsController.ts`:

```ts
import type { RequestHandler } from 'express';
import { RequestUploadBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { maxBytesForAttachment } from '../../shared/storage/presign.ts';
import { cancelPlayerUpload, requestPlayerUpload } from '../services/uploadsService.ts';

export const postUploadRequestHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const body = RequestUploadBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'filename, content_type and byte_size are required.');
    return;
  }
  if (body.data.byte_size > maxBytesForAttachment(body.data.content_type)) {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
    return;
  }
  const result = await requestPlayerUpload(ctx, body.data);
  if (result.outcome === 'invalid_media_type') {
    sendError(
      res,
      422,
      'unsupported_media_type',
      'Only PNG, JPEG, WEBP, GIF, MP4 or WEBM are accepted.',
    );
    return;
  }
  if (result.outcome === 'too_large') {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the size limit for this file type.');
    return;
  }
  res
    .status(200)
    .json({ key: result.key, upload_url: result.upload_url, expires_at: result.expires_at });
};

export const deleteUploadHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  // Normalized to a single string by uploadsRouter's wildcard-join middleware.
  const key = req.params.key as string;
  const result = await cancelPlayerUpload(ctx, key);
  if (result === 'not_owner') {
    sendError(res, 404, 'not_found', 'Upload not found.');
    return;
  }
  res.status(204).send();
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && pnpm test tests/surface.uploads.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/surface/services/uploadsService.ts backend/src/surface/controllers/uploadsController.ts backend/tests/surface.uploads.test.ts
git commit -m "Accept video uploads on the player-side presigned upload endpoint"
```

---

### Task 4: Backend — agent message send claims a video attachment

**Files:**

- Modify: `backend/src/agent/services/messagesService.ts`
- Test: `backend/tests/agent.messages.test.ts` (extend)

**Interfaces:**

- Consumes: `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`, `maxBytesForAttachment` from Task 1; `extensionFor` from Task 2 (already imported, now video-aware).

- [ ] **Step 1: Write the failing test**

Find the existing image-claim test in `backend/tests/agent.messages.test.ts` (search `describe('POST /agent/messages with an attachment'` or equivalent — copy its exact upload-then-claim fixture pattern, including whatever helper it uses to PUT a fixture object via `presignPutObject`). Add a sibling case:

```ts
it('claims a video attachment', async () => {
  const workspaceId = await seedWorkspace();
  const { agentId, token } = await seedAgentToken(workspaceId);
  // ...seed a conversation the same way the existing image test does...

  const key = `pending/${workspaceId}/${agentId}/${crypto.randomUUID()}.mp4`;
  const body = Buffer.from('fake-mp4-bytes');
  const { url } = await presignPutObject({
    key,
    contentType: 'video/mp4',
    contentLength: body.length,
  });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
    body,
  });

  const res = await request(app)
    .post('/messages')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Workspace-Id', workspaceId)
    .send({
      conversation_id: conversationId, // whatever variable the existing test uses
      body: '',
      attachment: { key, filename: 'clip.mp4', mime_type: 'video/mp4', byte_size: body.length },
    })
    .expect(200);

  expect(res.body.message.attachment).toMatchObject({
    filename: 'clip.mp4',
    mime_type: 'video/mp4',
    byte_size: body.length,
  });
});
```

Adapt the request body/conversation-setup to exactly match whatever the existing image-claim test in this file already does — do not invent a different request shape.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/agent.messages.test.ts`
Expected: FAIL — `attachment_mismatch`, because `video/mp4` fails the current `ALLOWED_IMAGE_MIME_TYPES` re-check.

- [ ] **Step 3: Swap the claim-time check**

In `backend/src/agent/services/messagesService.ts`, update the import:

```ts
import {
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  copyObject,
  deleteObject,
  headObject,
  maxBytesForAttachment,
} from '../../shared/storage/presign.ts';
```

Replace the defense-in-depth re-check inside `sendAgentMessage`:

```ts
if (
  !ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(
    real.contentType as (typeof ALLOWED_CHAT_ATTACHMENT_MIME_TYPES)[number],
  ) ||
  real.contentLength > maxBytesForAttachment(real.contentType)
) {
  return { outcome: 'attachment_mismatch' };
}
```

(The rest of the function — `extensionFor(real.contentType)` on the next line — needs no change; Task 2 already made it video-aware.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/agent.messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run the full backend suite**

Run: `cd backend && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/services/messagesService.ts backend/tests/agent.messages.test.ts
git commit -m "Allow the agent-console message send path to claim a video attachment"
```

---

### Task 5: Backend — player message send claims a video attachment (and form attachment field)

**Files:**

- Modify: `backend/src/surface/services/messagesService.ts`
- Test: `backend/tests/surface.messages.test.ts` (extend)

**Interfaces:**

- Consumes: `ALLOWED_CHAT_ATTACHMENT_MIME_TYPES`, `maxBytesForAttachment` from Task 1.
- Produces: nothing new — the form-attachment-field linkage code already treats the attachment id opaquely (it never inspects `mimeType`), so a video answering a form's `attachment` field needs no additional change once the claim check itself accepts video.

- [ ] **Step 1: Write the failing test**

In `backend/tests/surface.messages.test.ts`, find the existing `describe('POST /messages with an attachment', ...)` block and its `uploadFixtureImage` helper. Add:

```ts
async function uploadFixtureVideo(workspaceId: string, playerId: string) {
  const key = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.mp4`;
  const body = Buffer.from('fake-mp4-bytes');
  const { url } = await presignPutObject({
    key,
    contentType: 'video/mp4',
    contentLength: body.length,
  });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
    body,
  });
  return key;
}

it('claims a pending video and inserts an attachment row', async () => {
  const { workspaceId, playerId, token } = await setup();
  const key = await uploadFixtureVideo(workspaceId, playerId);

  const res = await request(app)
    .post('/messages')
    .set('Authorization', `Bearer ${token}`)
    .send({
      body: '',
      attachment: { key, filename: 'clip.mp4', mime_type: 'video/mp4', byte_size: 20 },
    })
    .expect(200);

  expect(res.body.message.body).toBe('clip.mp4');
  expect(res.body.message.attachment).toMatchObject({
    filename: 'clip.mp4',
    mime_type: 'video/mp4',
    byte_size: 20,
  });
});
```

(Place it inside the same `describe('POST /messages with an attachment', ...)` block the image tests live in, so it shares that block's `setup()`/imports.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/surface.messages.test.ts`
Expected: FAIL — `attachment_mismatch`, since `video/mp4` fails the current image-only re-check.

- [ ] **Step 3: Swap the claim-time check**

In `backend/src/surface/services/messagesService.ts`, update the import:

```ts
import {
  ALLOWED_CHAT_ATTACHMENT_MIME_TYPES,
  copyObject,
  deleteObject,
  headObject,
  maxBytesForAttachment,
} from '../../shared/storage/presign.ts';
```

Replace the defense-in-depth re-check inside `sendPlayerMessage`:

```ts
// Defense-in-depth: re-check the allowlist/size cap against the real,
// HEAD-verified values at claim time too, not only at presign time.
if (
  !ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(
    real.contentType as (typeof ALLOWED_CHAT_ATTACHMENT_MIME_TYPES)[number],
  ) ||
  real.contentLength > maxBytesForAttachment(real.contentType)
) {
  return { outcome: 'attachment_mismatch' };
}
```

(The extension is already derived from the client-supplied key's own suffix a few lines below — no `extensionFor` call to update here.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/surface.messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run the full backend suite**

Run: `cd backend && pnpm test`
Expected: PASS (the pre-existing `tests/jobs.botTurns.test.ts` flakiness, if it recurs, is unrelated to this change — confirm by checking the failure is in that file and not one you touched).

- [ ] **Step 6: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/surface.messages.test.ts
git commit -m "Allow the player message send path (and form attachment field) to claim a video attachment"
```

---

### Task 6: Frontend — shared `Composer` (agent console) accepts and previews video

**Files:**

- Modify: `frontend/src/features/chat/components/Composer.tsx`
- Test: `frontend/src/features/chat/components/Composer.test.tsx` (extend)
- Test: `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx` (label-only fix)

**Interfaces:**

- Produces: `Composer`'s file input `aria-label` is now `"Attach image or video"` — every caller/test asserting the old `"Attach image"` label must be updated in this task.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/features/chat/components/Composer.test.tsx`, update every existing `getByLabelText('Attach image')` / `queryByLabelText('Attach image')` to `'Attach image or video'` (6 occurrences — lines 13, 26, 59, 73, 85, 89 per the current file; grep to confirm before editing). Then add:

```ts
it('calls onUpload with a picked video, then onSend with the returned attachment on submit', async () => {
  const onUpload = vi.fn().mockResolvedValue({
    key: 'pending/ws/agent/uuid.mp4',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    byteSize: 20 * 1024 * 1024,
  });
  const onSend = vi.fn();
  render(<Composer onSend={onSend} allowAttachments onUpload={onUpload} />);

  const input = screen.getByLabelText('Attach image or video');
  const file = makeFile('clip.mp4', 'video/mp4', 20 * 1024 * 1024);
  fireEvent.change(input, { target: { files: [file] } });

  await screen.findByTestId('pending-video-preview');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(onUpload).toHaveBeenCalledWith(file);
  expect(onSend).toHaveBeenCalledWith('', undefined, {
    key: 'pending/ws/agent/uuid.mp4',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    byteSize: 20 * 1024 * 1024,
  });
});

it('rejects a video over the 50 MB video cap client-side, without calling onUpload', () => {
  const onUpload = vi.fn();
  render(<Composer onSend={() => {}} allowAttachments onUpload={onUpload} />);

  const input = screen.getByLabelText('Attach image or video');
  const big = makeFile('huge.mp4', 'video/mp4', 51 * 1024 * 1024);
  fireEvent.change(input, { target: { files: [big] } });

  expect(onUpload).not.toHaveBeenCalled();
  expect(screen.getByText(/50 MB or smaller/)).toBeInTheDocument();
});

it('accepts a video between the image cap and the video cap', async () => {
  const onUpload = vi.fn().mockResolvedValue({
    key: 'pending/ws/agent/uuid.webm',
    filename: 'clip.webm',
    mimeType: 'video/webm',
    byteSize: 30 * 1024 * 1024,
  });
  render(<Composer onSend={() => {}} allowAttachments onUpload={onUpload} />);

  const input = screen.getByLabelText('Attach image or video');
  fireEvent.change(input, {
    target: { files: [makeFile('clip.webm', 'video/webm', 30 * 1024 * 1024)] },
  });

  await screen.findByTestId('pending-video-preview');
  expect(onUpload).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm exec vitest run src/features/chat/components/Composer.test.tsx`
Expected: FAIL — the label-renamed assertions fail against the still-`"Attach image"` component, and `video/mp4` is rejected client-side by the image-only allowlist.

- [ ] **Step 3: Update `Composer.tsx`**

Replace the top-of-file constants and `handleFilePicked`:

```tsx
import { useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';

// Mirrors backend/src/shared/storage/presign.ts's ALLOWED_CHAT_ATTACHMENT_MIME_TYPES /
// maxBytesForAttachment. Duplicated rather than imported — the frontend
// doesn't import backend code — so a fast client-side rejection matches what
// the server would reject anyway, instead of round-tripping to find out.
const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm']);

function maxBytesForAttachment(mimeType: string): number {
  return VIDEO_MIME_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}
```

```tsx
const handleFilePicked = async (file: File) => {
  if (!onUpload) return;
  setUploadError(null);

  if (!ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(file.type)) {
    setUploadError('Only PNG, JPEG, WebP, GIF images or MP4/WebM videos are supported.');
    if (fileInputRef.current) fileInputRef.current.value = '';
    return;
  }
  const cap = maxBytesForAttachment(file.type);
  if (file.size > cap) {
    setUploadError(
      VIDEO_MIME_TYPES.has(file.type)
        ? 'Videos must be 50 MB or smaller.'
        : 'Images must be 10 MB or smaller.',
    );
    if (fileInputRef.current) fileInputRef.current.value = '';
    return;
  }

  setUploading(true);
  try {
    const uploaded = await onUpload(file);
    setPendingAttachment(uploaded);
    setPreviewUrl(URL.createObjectURL(file));
  } catch {
    setUploadError('Upload failed. Please try again.');
  } finally {
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
};
```

Replace the pending-attachment preview block and the file input's `accept`/`aria-label`:

```tsx
{
  pendingAttachment && previewUrl && (
    <div className="flex items-center gap-2">
      {VIDEO_MIME_TYPES.has(pendingAttachment.mimeType) ? (
        <video
          data-testid="pending-video-preview"
          src={previewUrl}
          muted
          className="h-14 w-14 rounded-md object-cover"
        />
      ) : (
        <img
          src={previewUrl}
          alt={pendingAttachment.filename}
          className="h-14 w-14 rounded-md object-cover"
        />
      )}
      <button
        type="button"
        aria-label="Remove attachment"
        onClick={clearAttachment}
        className="rounded-full bg-muted/20 p-1"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
```

```tsx
<input
  ref={fileInputRef}
  type="file"
  accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
  aria-label="Attach image or video"
  className="hidden"
  disabled={disabled || uploading}
  onChange={(event) => {
    const file = event.target.files?.[0];
    if (file) void handleFilePicked(file);
  }}
/>
```

Everything else in `Composer.tsx` (props, `submit`, `clearAttachment`, visibility toggle, textarea, send button) is unchanged.

- [ ] **Step 4: Fix the one other caller's test**

In `frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx`, update the `screen.getByLabelText('Attach image')` at (currently) line 295 to `screen.getByLabelText('Attach image or video')`.

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
cd frontend
pnpm exec vitest run src/features/chat/components/Composer.test.tsx
pnpm exec vitest run src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/chat/components/Composer.tsx frontend/src/features/chat/components/Composer.test.tsx frontend/src/surfaces/agent-console/pages/Inbox/components/ThreadPanel.test.tsx
git commit -m "Accept and preview video attachments in the shared agent-console Composer"
```

---

### Task 7: Frontend — webview `ChatComposer` accepts and previews video

**Files:**

- Modify: `frontend/src/surfaces/webview/components/chat/ChatComposer.tsx`
- Test: `frontend/src/surfaces/webview/components/chat/ChatComposer.test.tsx` (extend)
- Test: `frontend/src/surfaces/webview/pages/SupportChat.test.tsx` (label-only fix)

**Interfaces:**

- Produces: `ChatComposer`'s hidden file input `aria-label` is now `"Attach image or video"`; the visible trigger button's `aria-label` becomes `"Choose image or video"`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/surfaces/webview/components/chat/ChatComposer.test.tsx`, update the existing `getByLabelText('Attach image')`/`queryByLabelText('Attach image')` (line 8, 26) to `'Attach image or video'`, and `getByLabelText('Choose image')` (line 47) to `'Choose image or video'`. Then add:

```ts
it('shows a muted video preview for a picked video, not an img', async () => {
  const onUpload = vi.fn().mockResolvedValue({
    key: 'pending/ws/player/uuid.mp4',
    filename: 'clip.mp4',
    mimeType: 'video/mp4',
    byteSize: 20 * 1024 * 1024,
  });
  render(<ChatComposer onSend={() => {}} allowAttachments onUpload={onUpload} />);

  const input = screen.getByLabelText('Attach image or video');
  const file = new File([new Uint8Array(20)], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.change(input, { target: { files: [file] } });

  const video = await screen.findByTestId('pending-video-preview');
  expect(video.tagName).toBe('VIDEO');
});

it('rejects a video over the 50 MB video cap client-side', () => {
  const onUpload = vi.fn();
  render(<ChatComposer onSend={() => {}} allowAttachments onUpload={onUpload} />);

  const input = screen.getByLabelText('Attach image or video');
  const big = new File([new Uint8Array(1)], 'huge.mp4', { type: 'video/mp4' });
  Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
  fireEvent.change(input, { target: { files: [big] } });

  expect(onUpload).not.toHaveBeenCalled();
  expect(screen.getByText(/50 MB or smaller/)).toBeInTheDocument();
});
```

(Match whatever import style/render helper the existing file already uses — this mirrors the file's current pattern; adapt import lines if the existing file's `render(<ChatComposer .../>)` call signature differs.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm exec vitest run src/surfaces/webview/components/chat/ChatComposer.test.tsx`
Expected: FAIL — label mismatches, and `video/mp4` rejected by the image-only allowlist.

- [ ] **Step 3: Update `ChatComposer.tsx`**

Replace the top-of-file constants:

```tsx
// Mirrors backend/src/shared/storage/presign.ts's ALLOWED_CHAT_ATTACHMENT_MIME_TYPES /
// maxBytesForAttachment — same duplication rationale as
// features/chat/components/Composer.tsx's own copy of these constants: a
// fast client-side rejection that matches what the server would reject anyway.
const ALLOWED_CHAT_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm']);

function maxBytesForAttachment(mimeType: string): number {
  return VIDEO_MIME_TYPES.has(mimeType) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
}
```

Replace `handleFilePicked`:

```tsx
const handleFilePicked = async (file: File) => {
  if (!onUpload) return;
  setUploadError(null);

  if (!ALLOWED_CHAT_ATTACHMENT_MIME_TYPES.includes(file.type)) {
    setUploadError('Only PNG, JPEG, WebP, GIF images or MP4/WebM videos are supported.');
    if (fileInputRef.current) fileInputRef.current.value = '';
    return;
  }
  const cap = maxBytesForAttachment(file.type);
  if (file.size > cap) {
    setUploadError(
      VIDEO_MIME_TYPES.has(file.type)
        ? 'Videos must be 50 MB or smaller.'
        : 'Images must be 10 MB or smaller.',
    );
    if (fileInputRef.current) fileInputRef.current.value = '';
    return;
  }

  setUploading(true);
  try {
    const uploaded = await onUpload(file);
    setPendingAttachment(uploaded);
    setPreviewUrl(URL.createObjectURL(file));
  } catch {
    setUploadError('Upload failed. Please try again.');
  } finally {
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
};
```

Replace the pending-attachment preview block:

```tsx
{
  pendingAttachment && previewUrl && (
    <div className="flex items-center gap-2">
      {VIDEO_MIME_TYPES.has(pendingAttachment.mimeType) ? (
        <video
          data-testid="pending-video-preview"
          src={previewUrl}
          muted
          className="h-14 w-14 rounded-card object-cover"
        />
      ) : (
        <img
          src={previewUrl}
          alt={pendingAttachment.filename}
          className="h-14 w-14 rounded-card object-cover"
        />
      )}
      <button
        type="button"
        aria-label="Remove attachment"
        onClick={clearAttachment}
        className="rounded-full bg-surface p-1 text-muted"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
```

Replace the file input and trigger button's labels/accept:

```tsx
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
              aria-label="Attach image or video"
              className="hidden"
              disabled={disabled || uploading}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFilePicked(file);
              }}
            />
            <button
              type="button"
              aria-label="Choose image or video"
              disabled={disabled || uploading}
              onClick={() => {
                post({ type: 'expect_native_dialog' });
                fileInputRef.current?.click();
              }}
              className={cn(
                'inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-muted transition-colors outline-none',
                'disabled:opacity-60',
              )}
            >
              <Paperclip size={20} className="shrink-0" />
            </button>
```

Everything else in `ChatComposer.tsx` is unchanged.

- [ ] **Step 4: Fix `SupportChat.test.tsx`'s label references**

In `frontend/src/surfaces/webview/pages/SupportChat.test.tsx`, update both `queryByLabelText('Attach image')` (line ~192) and `getByLabelText('Attach image')` (line ~201) to `'Attach image or video'`.

- [ ] **Step 5: Run the tests to verify they pass**

Run:

```bash
cd frontend
pnpm exec vitest run src/surfaces/webview/components/chat/ChatComposer.test.tsx
pnpm exec vitest run src/surfaces/webview/pages/SupportChat.test.tsx
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/surfaces/webview/components/chat/ChatComposer.tsx frontend/src/surfaces/webview/components/chat/ChatComposer.test.tsx frontend/src/surfaces/webview/pages/SupportChat.test.tsx
git commit -m "Accept and preview video attachments in the webview ChatComposer"
```

---

### Task 8: Frontend — form `attachment` field accepts video

**Files:**

- Modify: `frontend/src/surfaces/webview/components/chat/FormCard.tsx`
- Test: `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx` (extend)

**Interfaces:**

- Produces: the attachment-field file input's `aria-label` becomes `"Attach image or video"`.

- [ ] **Step 1: Write the failing tests**

In `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx`, update the two existing `getByLabelText('Attach image')` calls (currently lines 200 and 241) to `'Attach image or video'`. Then add, alongside the existing `'advances to the next question after onSendAttachment resolves'` test:

```ts
it('advances to the next question after picking a video for the attachment field', async () => {
  const onSubmit = vi.fn();
  const onSendAttachment = vi.fn().mockResolvedValue(undefined);
  const form: PlayerFormView = {
    submission_id: 's1',
    form_id: 'f1',
    form_name: 'Proof of purchase',
    version: 1,
    fields: [
      { key: 'proof', label: 'Upload a photo or video', type: 'attachment', isRequired: false, position: 0 },
      { key: 'order_id', label: 'Order or receipt ID', type: 'short_text', isRequired: true, position: 1 },
    ],
    answers: [],
  };
  render(
    <FormCard
      form={form}
      onAnswer={vi.fn()}
      onSubmit={onSubmit}
      onSkip={vi.fn()}
      busy={false}
      onSendAttachment={onSendAttachment}
    />,
  );
  const file = new File([new Uint8Array(3)], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.change(screen.getByLabelText('Attach image or video'), { target: { files: [file] } });

  expect(await screen.findByText('2 of 2')).toBeInTheDocument();
  expect(onSendAttachment).toHaveBeenCalledWith('proof', file);
  expect(onSubmit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm exec vitest run src/surfaces/webview/components/chat/FormCard.test.tsx`
Expected: FAIL — `getByLabelText('Attach image or video')` finds nothing, since the input is still labeled `"Attach image"`.

- [ ] **Step 3: Update the `case 'attachment':` branch**

In `frontend/src/surfaces/webview/components/chat/FormCard.tsx`:

```tsx
    case 'attachment':
      // Bypasses draft/onChange entirely: picking a file drives its own
      // upload-then-advance path in FormCard (handleAttachmentPicked), not
      // the changed-value comparison Next relies on for typed fields.
      return (
        <div className="flex flex-col gap-2">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
            aria-label="Attach image or video"
            disabled={disabled}
            // Must post before the native picker opens (it starts as this
            // click's default action): the SDK's resume watchdog needs to
            // already know to expect the pause it's about to see.
            onClick={() => post({ type: 'expect_native_dialog' })}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onAttachmentPicked(file);
            }}
          />
        </div>
      );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pnpm exec vitest run src/surfaces/webview/components/chat/FormCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/webview/components/chat/FormCard.tsx frontend/src/surfaces/webview/components/chat/FormCard.test.tsx
git commit -m "Accept video in the form attachment field's file picker"
```

---

### Task 9: Frontend — render video attachments in the chat thread

**Files:**

- Modify: `frontend/src/features/chat/components/MessageBody.tsx`
- Test: `frontend/src/features/chat/components/MessageBody.test.tsx` (extend)

**Interfaces:**

- Consumes: `ChatAttachment.mimeType` (already present on the type — no change to `types.ts` needed).
- Produces: nothing new consumed elsewhere — `ChatBubbles.tsx`/`ThreadPanel.tsx` already pass `attachment` straight through to `MessageBody` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/features/chat/components/MessageBody.test.tsx`:

```tsx
it('renders a video element (not an img) for a message with a video attachment', () => {
  const { container } = render(
    <MessageBody
      authorType="agent"
      body="clip.mp4"
      attachment={{
        id: 'a1',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        byteSize: 3,
        url: 'https://example.test/clip.mp4',
      }}
    />,
  );
  const video = container.querySelector('video');
  expect(video).not.toBeNull();
  expect(video).toHaveAttribute('src', 'https://example.test/clip.mp4');
  expect(video).toHaveAttribute('controls');
  expect(container.querySelector('img')).toBeNull();
});

it('renders the fallback label when a video attachment has no url', () => {
  render(
    <MessageBody
      authorType="agent"
      body="clip.mp4"
      attachment={{
        id: 'a1',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        byteSize: 3,
        url: null,
      }}
    />,
  );
  expect(screen.getByText(/Attachment unavailable/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm exec vitest run src/features/chat/components/MessageBody.test.tsx`
Expected: FAIL — `container.querySelector('video')` is null; every attachment renders as `<img>` today regardless of `mimeType`.

- [ ] **Step 3: Branch the renderer on `mimeType`**

Replace the body of `MessageBody.tsx` from the `imageLoaded`/`imageErrored` state declarations through the end of the return statement:

```tsx
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [mediaErrored, setMediaErrored] = useState(false);

  const text = !MARKDOWN_AUTHORS.has(authorType) ? (
    <>{body}</>
  ) : (
    <ArticleBody markdown={body} dark={dark} />
  );

  if (!attachment) return text;

  // When a send carries no typed text, the server stores the filename as the
  // body (see sendAgentMessage) purely so the row always has non-empty text.
  // That's an implementation detail, not something the agent actually typed —
  // showing it a second time above the image would read as a duplicated caption.
  const hasTypedText = body.trim().length > 0 && body !== attachment.filename;
  const isVideo = attachment.mimeType.startsWith('video/');

  return (
    <div className="flex flex-col gap-1">
      {hasTypedText && text}
      {attachment.url && !mediaErrored ? (
        isVideo ? (
          <video
            src={attachment.url}
            controls
            className="max-w-xs rounded-md"
            onLoadedData={() => setMediaLoaded(true)}
            onError={() => setMediaErrored(true)}
          />
        ) : (
          <div
            className={`group relative h-64 w-64 max-w-full overflow-hidden rounded-md ${
              onImageClick ? 'cursor-pointer' : ''
            }`}
            {...(onImageClick && {
              role: 'button',
              tabIndex: 0,
              onClick: () => onImageClick(attachment),
              onKeyDown: (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onImageClick(attachment);
                }
              },
            })}
          >
            {!mediaLoaded && (
              <div className="absolute inset-0 animate-pulse rounded-md bg-muted/20" />
            )}
            <img
              src={attachment.url}
              alt={attachment.filename}
              className={`h-full w-full object-contain transition-opacity duration-200 ${
                mediaLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              onLoad={() => setMediaLoaded(true)}
              onError={() => setMediaErrored(true)}
            />
            {onImageClick && mediaLoaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-150 group-hover:bg-black/30 group-hover:opacity-100">
                <Maximize2 className="size-6 text-white drop-shadow" />
              </div>
            )}
          </div>
        )
      ) : (
        <span className="text-xs italic opacity-75">
          Attachment unavailable — {attachment.filename}
        </span>
      )}
    </div>
  );
}
```

(`mediaLoaded`/`mediaErrored` are the renamed `imageLoaded`/`imageErrored` — they now cover both element types. No other part of the file changes; `onImageClick` stays image-only, since click-to-expand was never specified for video.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && pnpm exec vitest run src/features/chat/components/MessageBody.test.tsx`
Expected: PASS — including the pre-existing image tests, unaffected by the rename.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/chat/components/MessageBody.tsx frontend/src/features/chat/components/MessageBody.test.tsx
git commit -m "Render video attachments as an inline video player in the chat thread"
```

---

### Task 10: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Run the full backend suite**

Run: `cd backend && pnpm test`
Expected: PASS. If `tests/jobs.botTurns.test.ts` fails, confirm (by re-running just that file in isolation) it is the same pre-existing BullMQ/Redis timing flakiness noted in the prior attachment-field work, not a regression from this plan — do not treat it as a blocker if so.

- [ ] **Step 2: Run the full frontend suite**

Run: `cd frontend && pnpm test -- --run` (or `pnpm exec vitest run` if the `test` script's arg-forwarding swallows `--run` as seen previously in this repo)
Expected: PASS, modulo the same pre-existing unrelated flaky suites observed in the prior attachment-field work (`ChatThread.test.tsx`, `SupportChat banner focus`, `ContextRail.test.tsx`, `ThreadPanel optimistic sends`, `SupportHero`/`TopBar` timing tests) — confirm any failure here is one of those, not something this plan's changes caused.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck` (repo root — runs `tsc --noEmit` across all workspace packages plus `eslint .` for frontend)
Expected: clean, no errors.

- [ ] **Step 4: Manual check with `run`**

Start the app, and: (a) send a short MP4 from the agent console composer and confirm it plays inline for both the agent and the player's webview thread; (b) send a short MP4/WebM from the player webview composer and confirm it plays inline in the agent console; (c) trigger a form with an `attachment` field and confirm picking a video (not just a photo) advances the form and posts a playable video message.
